import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeCanvasDefinition } from "@octant/contracts/canvas";
import {
  CANVAS_PREVIEW_BROWSER_ARGS,
  CANVAS_PREVIEW_ORIGIN,
  canvasPreviewAssetPath,
  canvasPreviewDesignPageIndex,
  canvasPreviewPageWithInput,
  createPlaywrightCanvasPreviewRenderer,
} from "./canvasPreviewRenderer";

const root = "/srv/octant/web/dist/canvas-preview";

describe("canvas preview requests", () => {
  it("answers a request for one of the preview page's own built files", () => {
    expect(canvasPreviewAssetPath(`${CANVAS_PREVIEW_ORIGIN}/assets/page-abc.js`, root)).toBe(
      `${root}/assets/page-abc.js`,
    );
  });

  it("refuses any other origin, a path out of the preview folder, and the folder itself", () => {
    expect(canvasPreviewAssetPath("https://example.com/assets/page.js", root)).toBeUndefined();
    expect(canvasPreviewAssetPath("http://127.0.0.1:4100/api/canvas", root)).toBeUndefined();
    // The URL parser folds a dot segment away before the path is read, so it
    // can only ever land inside the folder.
    expect(canvasPreviewAssetPath(`${CANVAS_PREVIEW_ORIGIN}/%2e%2e/index.html`, root)).toBe(
      `${root}/index.html`,
    );
    expect(
      canvasPreviewAssetPath(`${CANVAS_PREVIEW_ORIGIN}/assets/%2e%2e%2f%2e%2e%2fsecret`, root),
    ).toBeUndefined();
    expect(canvasPreviewAssetPath(`${CANVAS_PREVIEW_ORIGIN}/`, root)).toBeUndefined();
    expect(canvasPreviewAssetPath("data:text/html,hi", root)).toBeUndefined();
  });
});

describe("a running design's page in the preview", () => {
  it("is answered only at its position under the preview origin", () => {
    expect(canvasPreviewDesignPageIndex(`${CANVAS_PREVIEW_ORIGIN}/design-page/0`)).toBe(0);
    expect(canvasPreviewDesignPageIndex(`${CANVAS_PREVIEW_ORIGIN}/design-page/12`)).toBe(12);
    for (const url of [
      "http://example.test/design-page/0",
      `${CANVAS_PREVIEW_ORIGIN}/design-page/`,
      `${CANVAS_PREVIEW_ORIGIN}/design-page/0?ticket=x`,
      `${CANVAS_PREVIEW_ORIGIN}/design-page/../canvas-preview.html`,
      `${CANVAS_PREVIEW_ORIGIN}/design-page/1e3`,
      "not a url",
    ]) {
      expect(canvasPreviewDesignPageIndex(url), url).toBeUndefined();
    }
  });

  it("starts the preview browser with no route out for what interception cannot see", () => {
    expect(CANVAS_PREVIEW_BROWSER_ARGS).toEqual([
      "--proxy-server=socks5://127.0.0.1:1",
      "--proxy-bypass-list=<-loopback>",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ]);
  });
});

describe("canvas preview page input", () => {
  const definition = decodeCanvasDefinition({
    schemaVersion: 1,
    title: "</script><script>alert(1)</script>",
    provenance: {
      hostId: "host-1",
      projectId: "22222222-2222-4222-8222-222222222222",
      mode: "chat",
      threadId: "33333333-3333-4333-8333-333333333333",
      actor: { kind: "agent", actorId: "44444444-4444-4444-8444-444444444444" },
      providerInstanceId: "55555555-5555-4555-8555-555555555555",
      modelId: "model",
      createdAt: "2026-10-07T00:00:00.000Z",
    },
    sourceManifest: [],
    blocks: [],
  });

  it("writes the document into the page as data that cannot close its own block", () => {
    const page = canvasPreviewPageWithInput("<html><head></head><body></body></html>", {
      definition,
      theme: "dark",
      placement: "thread",
    });
    if (page === undefined) throw new Error("The page was refused.");
    const start = page.indexOf('<script type="application/json" id="canvas-preview-data">');
    const end = page.indexOf("</script>", start);
    const data = page.slice(start, end);
    expect(data).not.toContain("</");
    expect(data).not.toContain("<script>");
    const json = data.slice(data.indexOf(">") + 1);
    expect(JSON.parse(json)).toMatchObject({
      theme: "dark",
      placement: "thread",
      definition: { title: "</script><script>alert(1)</script>" },
    });
  });

  it("refuses a page without a head", () => {
    expect(
      canvasPreviewPageWithInput("<body></body>", {
        definition,
        theme: "light",
        placement: "document",
      }),
    ).toBeUndefined();
  });

  it("says a build without the preview page has no renderer, before starting a browser", async () => {
    const emptyAssets = await mkdtemp(join(tmpdir(), "octant-canvas-preview-"));
    try {
      const renderer = createPlaywrightCanvasPreviewRenderer({
        webAssetsPath: emptyAssets,
        executableCandidates: ["/nonexistent/chromium"],
        executable: async () => true,
      });
      await expect(
        renderer.render({ definition, width: 400, theme: "light", placement: "document" }),
      ).resolves.toEqual({ kind: "unavailable", reason: "no-renderer" });
    } finally {
      await rm(emptyAssets, { recursive: true, force: true });
    }
  });

  it("reports a browser that will not start as a failed look instead of throwing", async () => {
    const assets = await mkdtemp(join(tmpdir(), "octant-canvas-preview-"));
    try {
      await mkdir(join(assets, "canvas-preview"));
      await writeFile(
        join(assets, "canvas-preview", "canvas-preview.html"),
        "<html><head></head><body></body></html>",
      );
      const renderer = createPlaywrightCanvasPreviewRenderer({
        webAssetsPath: assets,
        executableCandidates: ["/nonexistent/chromium"],
        executable: async () => true,
        launch: async () => {
          throw new Error("Chromium refused to start.");
        },
      });
      await expect(
        renderer.render({ definition, width: 400, theme: "light", placement: "document" }),
      ).resolves.toEqual({ kind: "unavailable", reason: "failed" });
    } finally {
      await rm(assets, { recursive: true, force: true });
    }
  });
});
