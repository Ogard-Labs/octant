import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";
import type { DesignAssetRuntime } from "./designDocument";

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cover = decodeCanvasBlock({
  blockId: "cover",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "image",
  generatedImageId: "11111111-1111-4111-8111-111111111111",
  alt: "A lighthouse at dusk",
  caption: "Cover art",
});

function drawWith(runtime: DesignAssetRuntime | undefined) {
  return render(
    <CanvasDocument
      definition={{ ...canvasFixture, blocks: [cover] }}
      {...(runtime === undefined ? {} : { designAssetRuntime: runtime })}
    />,
  );
}

describe("an image block that draws a generated image", () => {
  afterEach(cleanup);

  it("asks the host for the image each time it is drawn and shows the picture it answers", async () => {
    const resolve = vi.fn<DesignAssetRuntime["resolve"]>(async () => [
      { assetId: "image" as never, status: "resolved", mediaType: "image/png", data: PIXEL },
    ]);
    drawWith({ resolve });
    expect(screen.getByText("Loading image")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading image")).toBeNull());
    const picture = screen.getByRole("img", { name: "A lighthouse at dusk" });
    expect(picture.tagName).toBe("IMG");
    expect(picture).toHaveAttribute("src", `data:image/png;base64,${PIXEL}`);
    expect(screen.getByText("Cover art")).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith("cover");
  });

  it("says the image is unavailable when its job is gone or no host can be asked", async () => {
    drawWith({
      resolve: async () => [
        { assetId: "image" as never, status: "unavailable", reason: "missing" },
      ],
    });
    expect(await screen.findByText("Image unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "A lighthouse at dusk" })?.tagName).not.toBe("IMG");
    cleanup();

    drawWith(undefined);
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
  });
});
