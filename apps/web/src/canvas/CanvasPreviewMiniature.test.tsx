import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasPreviewMiniature } from "./CanvasPreviewMiniature";

const canvasId = "20000000-0000-4000-8000-000000000002";
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
    expect(screen.getByText("Version 3, as the agent previewed it")).toBeTruthy();
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
