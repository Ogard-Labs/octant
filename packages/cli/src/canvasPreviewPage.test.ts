import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANVAS_PREVIEW_PAGE_PATH, ensureCanvasPreviewPage } from "./canvasPreviewPage";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A web root with one renderer source and the preview page's own markup, both written at `sourceTime`. */
async function webRoot(sourceTime: Date): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "octant-canvas-preview-page-"));
  roots.push(repo);
  const root = join(repo, "apps", "web");
  await mkdir(join(root, "src", "canvas"), { recursive: true });
  for (const file of ["src/canvas/canvasPreviewPage.tsx", "canvas-preview.html"]) {
    await writeFile(join(root, file), "");
    await utimes(join(root, file), sourceTime, sourceTime);
  }
  return root;
}

/** A workspace package source the web app bundles, written at `at` beside the web root. */
async function packageSource(root: string, name: string, at: Date): Promise<void> {
  const file = join(root, "..", "..", "packages", name, "src", "index.ts");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "");
  await utimes(file, at, at);
}

async function builtPage(root: string, at: Date): Promise<void> {
  const page = join(root, CANVAS_PREVIEW_PAGE_PATH);
  await mkdir(dirname(page), { recursive: true });
  await writeFile(page, "<html></html>");
  await utimes(page, at, at);
}

const earlier = new Date("2026-10-20T10:00:00Z");
const later = new Date("2026-10-20T11:00:00Z");

describe("ensureCanvasPreviewPage", () => {
  it("builds the preview page when the web build carries none", async () => {
    const root = await webRoot(earlier);
    const build = vi.fn(async () => 0);
    await expect(ensureCanvasPreviewPage({ webRoot: root, build })).resolves.toEqual({
      status: "built",
    });
    expect(build).toHaveBeenCalledWith(root);
  });

  it("leaves a built page alone when it is newer than every renderer source", async () => {
    const root = await webRoot(earlier);
    await builtPage(root, later);
    const build = vi.fn(async () => 0);
    await expect(ensureCanvasPreviewPage({ webRoot: root, build })).resolves.toEqual({
      status: "current",
    });
    expect(build).not.toHaveBeenCalled();
  });

  it("rebuilds the page when a renderer source changed after it was built", async () => {
    const root = await webRoot(later);
    await builtPage(root, earlier);
    const build = vi.fn(async () => 0);
    await expect(ensureCanvasPreviewPage({ webRoot: root, build })).resolves.toEqual({
      status: "built",
    });
  });

  it.each(["contracts", "domain", "theme"])(
    "rebuilds the page when the %s package changed after it was built",
    async (name) => {
      const root = await webRoot(earlier);
      await builtPage(root, new Date("2026-10-20T10:30:00Z"));
      await packageSource(root, name, later);
      const build = vi.fn(async () => 0);
      await expect(ensureCanvasPreviewPage({ webRoot: root, build })).resolves.toEqual({
        status: "built",
      });
      expect(build).toHaveBeenCalledOnce();
    },
  );

  it("reports a build that failed with its exit code", async () => {
    const root = await webRoot(earlier);
    await expect(ensureCanvasPreviewPage({ webRoot: root, build: async () => 2 })).resolves.toEqual(
      { status: "failed", exitCode: 2 },
    );
  });
});
