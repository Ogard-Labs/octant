import { describe, expect, it, vi } from "vitest";
import type { CanvasBlock } from "@octant/contracts/canvas";
import { decodeCanvasBlock, decodeCanvasId } from "@octant/contracts";
import { createCanvasPreviewService } from "./canvasPreviewService";
import type { CanvasPreviewRenderer } from "./canvasPreviewRenderer";

const canvasId = decodeCanvasId("77777777-7777-4777-8777-777777777777");

function definitionBlock(): CanvasBlock {
  return decodeCanvasBlock({
    blockId: "revenue",
    schemaVersion: 1,
    kind: "chart",
    chartType: "grouped-bar",
    series: [
      { seriesId: "this", label: "This year", points: [{ x: "Q1", y: 1 }] },
      { seriesId: "last", label: "Last year", points: [{ x: "Q1", y: 2 }] },
    ],
  });
}

const definition = {
  title: "Revenue",
  presentation: "sidebar" as const,
  blocks: [definitionBlock()],
};

function canvasStub() {
  return {
    get: () => ({
      kind: "ready" as const,
      version: {
        canvasId,
        versionId: "version-1",
        sequence: 1,
        definition,
      },
    }),
    history: () => ({
      kind: "ready" as const,
      history: { canvasId, currentVersionId: "version-1", entries: [] },
    }),
  } as never;
}

function rendererStub(outcome: Awaited<ReturnType<CanvasPreviewRenderer["render"]>>) {
  return {
    available: vi.fn(async () => outcome.kind === "rendered"),
    render: vi.fn(async () => outcome),
  } satisfies CanvasPreviewRenderer;
}

const context = { mode: "chat" as const, projectId: "22222222-2222-4222-8222-222222222222" };
const project = { id: context.projectId, type: "chat" as const, lifecycle: "active" as const };

function request(overrides: Record<string, unknown> = {}) {
  return {
    canvasId,
    threadKey: "thread-a",
    width: "sidebar" as const,
    theme: "light" as const,
    imagesInToolResults: true,
    ...overrides,
  };
}

describe("createCanvasPreviewService", () => {
  it("resolves a design's images before drawing it and warns about each it could not draw", async () => {
    const design = decodeCanvasBlock({
      blockId: "phone",
      schemaVersion: 17,
      kind: "design",
      title: "Onboarding",
      size: "phone",
      assets: [
        { assetId: "shot", source: { kind: "project-file", path: "screens/home.png" } },
        { assetId: "other", source: { kind: "project-file", path: "../other.png" } },
      ],
      frames: [
        {
          frameId: "home",
          title: "Home",
          html: '<img src="octant-asset:shot" alt=""><img src="octant-asset:other" alt="">',
        },
      ],
    });
    const provenance = { mode: "work", projectId: context.projectId, threadId: "thread-a" };
    const canvas = {
      get: () => ({
        kind: "ready" as const,
        version: {
          canvasId,
          versionId: "version-1",
          sequence: 1,
          definition: { ...definition, provenance, blocks: [design] },
        },
      }),
      history: () => ({ kind: "ready" as const, history: { entries: [] } }),
    } as never;
    const resolved = [
      { assetId: "shot", status: "resolved", mediaType: "image/png", data: "iVBORw0KGgo=" },
      { assetId: "other", status: "unavailable", reason: "refused" },
    ] as never;
    const resolveDesignAssets = vi.fn(async () => resolved);
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1]),
      height: 10,
      designs: [],
    });
    const service = createCanvasPreviewService({ canvas, renderer, resolveDesignAssets });

    const outcome = await service.preview(request(), context, project);

    expect(resolveDesignAssets).toHaveBeenCalledWith(design, provenance);
    expect(outcome).toMatchObject({
      kind: "preview",
      warnings: [
        {
          kind: "design-asset-unavailable",
          blockId: "phone",
          assetId: "other",
          reason: "refused",
          frameIds: ["home"],
        },
      ],
    });
    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ designAssets: [{ blockId: "phone", assets: resolved }] }),
    );
  });

  it("runs a prototype in the preview and returns the script error it threw, its overflow, and its faint text", async () => {
    const prototype = decodeCanvasBlock({
      blockId: "cart",
      schemaVersion: 18,
      kind: "design",
      title: "Cart",
      size: "phone",
      runsScript: true,
      frames: [{ frameId: "cart", title: "Cart", html: "<script>missing()</script>" }],
    });
    const canvas = {
      get: () => ({
        kind: "ready" as const,
        version: {
          canvasId,
          versionId: "version-1",
          sequence: 1,
          definition: { ...definition, blocks: [prototype] },
        },
      }),
      history: () => ({ kind: "ready" as const, history: { entries: [] } }),
    } as never;
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1]),
      height: 10,
      designs: [
        {
          blockId: "cart",
          scriptErrors: ["Uncaught ReferenceError: missing is not defined"],
          overflow: [{ frameId: "cart", overflowPx: 120 }],
          contrast: [
            {
              frameId: "cart",
              text: "Total",
              foreground: "#bbbbbb",
              background: "#ffffff",
              ratio: 1.92,
              target: 4.5,
            },
          ],
        },
      ],
    });
    const service = createCanvasPreviewService({ canvas, renderer });

    // A model that is shown no picture still gets what the drawn frames read as.
    const outcome = await service.preview(
      request({ imagesInToolResults: false }),
      context,
      project,
    );

    // The page the preview runs is the page a reader's frame is served.
    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        designPages: [
          {
            blockId: "cart",
            html: expect.stringMatching(
              /octant-design-frame@1[\s\S]*<script>missing\(\)<\/script>/,
            ),
          },
        ],
      }),
    );
    expect(outcome).toMatchObject({
      kind: "preview",
      imageOmitted: "provider-cannot-take-images",
      warnings: [
        {
          kind: "design-script-error",
          blockId: "cart",
          message: "Uncaught ReferenceError: missing is not defined",
        },
        { kind: "design-frame-overflow", blockId: "cart", frameId: "cart", overflowPx: 120 },
        {
          kind: "design-contrast-below-target",
          blockId: "cart",
          frameId: "cart",
          text: "Total",
          ratio: 1.92,
          target: 4.5,
        },
      ],
    });
    expect(outcome).not.toHaveProperty("image");
  });

  it("attaches a PNG and the warnings when a browser exists and the model takes images", async () => {
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1, 2, 3, 4]),
      height: 480,
      designs: [],
    });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const outcome = await service.preview(request(), context, project);
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.image?.mimeType).toBe("image/png");
    expect(outcome.image?.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(outcome.imageOmitted).toBeUndefined();
    expect(outcome.sequence).toBe(1);
    // The height reported is the picture's own, not an estimate from the blocks.
    expect(outcome.height).toBe(480);
  });

  it("draws an inline preview the way the thread places it, in the chosen theme", async () => {
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1]),
      height: 200,
      designs: [],
    });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    await service.preview(request({ width: "inline", theme: "dark" }), context, project);
    expect(renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ placement: "thread", theme: "dark", definition }),
    );
  });

  it("names a build without the preview page and a failed look apart from a missing browser", async () => {
    for (const [reason, omitted] of [
      ["no-renderer", "no-renderer"],
      ["failed", "render-failed"],
    ] as const) {
      const renderer: CanvasPreviewRenderer = {
        available: async () => true,
        render: async () => ({ kind: "unavailable", reason }),
      };
      const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
      const outcome = await service.preview(request({ threadKey: reason }), context, project);
      expect(outcome.kind).toBe("preview");
      if (outcome.kind !== "preview") return;
      expect(outcome.imageOmitted).toBe(omitted);
      expect(outcome.height).toBeUndefined();
    }
  });

  it("returns the warnings and says why when the model cannot take images", async () => {
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1]),
      height: 480,
      designs: [],
    });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const outcome = await service.preview(
      request({ imagesInToolResults: false }),
      context,
      project,
    );
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.image).toBeUndefined();
    expect(outcome.imageOmitted).toBe("provider-cannot-take-images");
    expect(outcome.warnings).toEqual([]);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("returns the warnings and says why when the host has no browser", async () => {
    const renderer = rendererStub({ kind: "unavailable", reason: "no-browser" });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const outcome = await service.preview(request(), context, project);
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.image).toBeUndefined();
    expect(outcome.imageOmitted).toBe("no-browser");
  });

  it("holds one preview in flight per thread", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renderer: CanvasPreviewRenderer = {
      available: async () => true,
      render: async () => {
        await blocked;
        return { kind: "rendered", png: new Uint8Array([1]), height: 480, designs: [] };
      },
    };
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const first = service.preview(request(), context, project);
    const second = await service.preview(request(), context, project);
    expect(second.kind).toBe("busy");
    release?.();
    expect((await first).kind).toBe("preview");
  });

  it("rate limits repeated previews of the same thread", async () => {
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1]),
      height: 480,
      designs: [],
    });
    const service = createCanvasPreviewService({
      canvas: canvasStub(),
      renderer,
      previewsPerWindow: 2,
      windowMs: 60_000,
    });
    expect((await service.preview(request(), context, project)).kind).toBe("preview");
    expect((await service.preview(request(), context, project)).kind).toBe("preview");
    expect((await service.preview(request(), context, project)).kind).toBe("rate-limited");
  });

  it("refuses a version the Canvas does not have", async () => {
    const renderer = rendererStub({
      kind: "rendered",
      png: new Uint8Array([1]),
      height: 480,
      designs: [],
    });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const outcome = await service.preview(request({ version: 9 }), context, project);
    expect(outcome.kind).toBe("unavailable");
  });
});
