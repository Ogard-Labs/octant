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
  it("attaches a PNG and the warnings when a browser exists and the model takes images", async () => {
    const renderer = rendererStub({ kind: "rendered", png: new Uint8Array([1, 2, 3, 4]) });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const outcome = await service.preview(request(), context, project);
    expect(outcome.kind).toBe("preview");
    if (outcome.kind !== "preview") return;
    expect(outcome.image?.mimeType).toBe("image/png");
    expect(outcome.image?.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(outcome.imageOmitted).toBeUndefined();
    expect(outcome.sequence).toBe(1);
  });

  it("returns the warnings and says why when the model cannot take images", async () => {
    const renderer = rendererStub({ kind: "rendered", png: new Uint8Array([1]) });
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
    const renderer = rendererStub({ kind: "unavailable" });
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
        return { kind: "rendered", png: new Uint8Array([1]) };
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
    const renderer = rendererStub({ kind: "rendered", png: new Uint8Array([1]) });
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
    const renderer = rendererStub({ kind: "rendered", png: new Uint8Array([1]) });
    const service = createCanvasPreviewService({ canvas: canvasStub(), renderer });
    const outcome = await service.preview(request({ version: 9 }), context, project);
    expect(outcome.kind).toBe("unavailable");
  });
});
