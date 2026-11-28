import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import { render, screen, waitFor } from "@testing-library/react";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { describe, expect, it, vi } from "vitest";
import { canvasFixture } from "./test-fixtures";
import { CanvasPreviewMiniature } from "./CanvasPreviewMiniature";

const canvasId = "20000000-0000-4000-8000-000000000002";
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const preview = { canvasId, versionId: "20000000-0000-4000-8000-000000000003" };

describe("the miniature of a previewed Canvas", () => {
  it("reads the exact version the agent previewed and draws it inert", async () => {
    const get = vi.fn().mockResolvedValue({
      kind: "ready",
      version: {
        canvasId,
        versionId: preview.versionId,
        sequence: 3,
        definition: { title: "Where CI time goes", presentation: "inline", blocks: [] },
      },
    });
    const { container } = render(
      <CanvasPreviewMiniature client={{ get } as unknown as CanvasClient} preview={preview} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".canvas-preview-shot__frame")).not.toBeNull();
    });
    expect(get).toHaveBeenCalledWith(canvasId, preview.versionId);
    const frame = container.querySelector(".canvas-preview-shot__frame");
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame).toHaveAttribute("inert");
    expect(screen.getByText("Version 3, previewed by the agent")).toBeTruthy();
  });

  it("asks the host for the previewed version's images, so they draw as the agent saw them", async () => {
    const cover = decodeCanvasBlock({
      blockId: "cover",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "image",
      generatedImageId: "11111111-1111-4111-8111-111111111111",
      alt: "A lighthouse at dusk",
    });
    const get = vi.fn().mockResolvedValue({
      kind: "ready",
      version: {
        canvasId,
        versionId: preview.versionId,
        sequence: 3,
        definition: { ...canvasFixture, presentation: "inline", blocks: [cover] },
      },
    });
    const designAssets = vi.fn().mockResolvedValue({
      kind: "ready",
      assets: [{ assetId: "image", status: "resolved", mediaType: "image/png", data: PIXEL }],
    });
    const { container } = render(
      <CanvasPreviewMiniature
        client={{ get, designAssets } as unknown as CanvasClient}
        preview={preview}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".canvas-preview-shot__frame img")).not.toBeNull();
    });
    expect(designAssets).toHaveBeenCalledWith({
      canvasId,
      versionId: preview.versionId,
      blockId: "cover",
      marks: "recorded",
    });
  });

  it("draws the changed placeholder on the newest version when a Project image was replaced, and labels an unrecorded version", async () => {
    const screenDesign = decodeCanvasBlock({
      blockId: "screen",
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "design",
      title: "Screen",
      size: "document",
      assets: [{ assetId: "shot", source: { kind: "project-file", path: "screens/home.png" } }],
      frames: [{ frameId: "home", title: "Home", html: '<img src="octant-asset:shot" alt="">' }],
    });
    const get = vi.fn().mockResolvedValue({
      kind: "ready",
      version: {
        canvasId,
        versionId: preview.versionId,
        sequence: 1,
        definition: {
          ...canvasFixture,
          provenance: { ...canvasFixture.provenance, mode: "work" },
          presentation: "inline",
          blocks: [screenDesign],
        },
      },
    });
    const changedAssets = vi.fn().mockResolvedValue({
      kind: "ready",
      assets: [{ assetId: "shot", status: "unavailable", reason: "changed" }],
    });
    const first = render(
      <CanvasPreviewMiniature
        client={{ get, designAssets: changedAssets } as unknown as CanvasClient}
        preview={preview}
      />,
    );
    await waitFor(() => {
      const iframe = first.container.querySelector("iframe");
      expect(iframe).not.toBeNull();
      const srcDoc = iframe?.getAttribute("srcdoc") ?? "";
      const match = srcDoc.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/);
      expect(match?.[1]).toBeTruthy();
      expect(atob(match?.[1] ?? "")).toContain("Image changed since this version");
    });
    expect(changedAssets).toHaveBeenCalledWith({
      canvasId,
      versionId: preview.versionId,
      blockId: "screen",
      marks: "recorded",
    });
    expect(screen.queryByText("Project images are shown as they are now")).toBeNull();
    first.unmount();

    const unrecordedAssets = vi.fn().mockResolvedValue({
      kind: "ready",
      assets: [
        {
          assetId: "shot",
          status: "resolved",
          mediaType: "image/png",
          data: PIXEL,
          mark: "unrecorded",
        },
      ],
    });
    render(
      <CanvasPreviewMiniature
        client={{ get, designAssets: unrecordedAssets } as unknown as CanvasClient}
        preview={preview}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Project images are shown as they are now")).toBeTruthy();
    });
  });

  it("says so in a plain line when this window cannot read the Canvas", async () => {
    const get = vi.fn().mockResolvedValue({ kind: "unavailable" });
    render(
      <CanvasPreviewMiniature client={{ get } as unknown as CanvasClient} preview={preview} />,
    );
    await waitFor(() => {
      expect(screen.getByText("The previewed Canvas is unavailable.")).toBeTruthy();
    });
  });
});
