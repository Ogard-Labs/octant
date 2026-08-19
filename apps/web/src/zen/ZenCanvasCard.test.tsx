import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasId } from "@octant/contracts/canvas";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenCanvasCard } from "./ZenCanvasCard";

const canvasId = "90000000-0000-4000-8000-000000000001" as CanvasId;

function readyOutcome(title: string) {
  return {
    kind: "ready" as const,
    version: {
      definition: {
        schemaVersion: 1,
        title,
        blocks: [
          {
            blockId: "a0000000-0000-4000-8000-000000000001",
            schemaVersion: 1,
            kind: "rich-text" as const,
            text: "Ship the technical preview.",
          },
        ],
      },
    },
  };
}

describe("ZenCanvasCard", () => {
  it("reads the canvas the card names rather than carrying a copy of it", async () => {
    const get = vi.fn(async () => readyOutcome("Release plan") as never);
    render(<ZenCanvasCard canvasId={canvasId} client={{ get } as Pick<CanvasClient, "get">} />);

    expect(await screen.findByText("Ship the technical preview.")).toBeTruthy();
    expect(get).toHaveBeenCalledWith(canvasId);
  });

  it("says a canvas it may no longer read is unavailable without guessing why", async () => {
    // Whether the refusal was authority or absence is the host's to tell the
    // Canvas surface; a card repeating it would say more than it was told.
    const get = vi.fn(async () => ({ kind: "unauthorized", canvasId }) as never);
    render(<ZenCanvasCard canvasId={canvasId} client={{ get } as Pick<CanvasClient, "get">} />);

    expect(await screen.findByText("This canvas is unavailable.")).toBeTruthy();
  });

  it("keeps the last reading on screen and says it is old when a re-read refuses", async () => {
    let call = 0;
    const get = vi.fn(
      async () =>
        (call++ === 0 ? readyOutcome("Release plan") : { kind: "unauthorized", canvasId }) as never,
    );
    const { rerender } = render(
      <ZenCanvasCard canvasId={canvasId} client={{ get } as Pick<CanvasClient, "get">} />,
    );
    expect(await screen.findByText("Ship the technical preview.")).toBeTruthy();

    (await screen.findByRole("button", { name: "Re-read this canvas" })).click();
    rerender(<ZenCanvasCard canvasId={canvasId} client={{ get } as Pick<CanvasClient, "get">} />);

    await waitFor(() =>
      expect(
        screen.getByText(/This canvas is unavailable\. This is the last reading\./),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Ship the technical preview.")).toBeTruthy();
  });
});
