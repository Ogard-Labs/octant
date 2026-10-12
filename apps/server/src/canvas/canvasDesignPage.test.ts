import { CANVAS_DESIGN_ASSETS_MAX_BYTES, type CanvasDesignBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { renderCanvasDesignPage } from "./canvasDesignPage";

function checkout(html: string): CanvasDesignBlock {
  return {
    blockId: "checkout",
    kind: "design",
    title: "Checkout",
    size: "phone",
    runsScript: true,
    assets: [
      {
        assetId: "hero",
        source: { kind: "generated-image", imageId: "44444444-4444-4444-8444-444444444444" },
      },
    ],
    frames: [{ frameId: "cart", title: "Cart", html }],
  } as unknown as CanvasDesignBlock;
}

describe("a running design's page", () => {
  it("stays within the page budget however often a large image is referenced", () => {
    // The largest image the host inlines, as base64.
    const data = "A".repeat(Math.ceil((3 * 1024 * 1024) / 3) * 4);
    const page = renderCanvasDesignPage(
      checkout(Array.from({ length: 6 }, () => '<img src="octant-asset:hero" alt="">').join("")),
      "cart",
      [{ assetId: "hero" as never, status: "resolved", mediaType: "image/png", data }],
    );
    expect(page).toContain(`src="data:image/png;base64,${data}"`);
    expect(page.split(data).length - 1).toBeLessThan(6);
    expect(page.length).toBeLessThan(
      Math.ceil(CANVAS_DESIGN_ASSETS_MAX_BYTES / 3) * 4 + 256 * 1024,
    );
    expect(page).not.toContain("octant-asset:");
  });

  it("writes an image in only where it is loaded, leaving prose and other attributes as written", () => {
    const page = renderCanvasDesignPage(
      checkout(
        '<p>Name it <code>octant-asset:hero</code>.</p><img src="octant-asset:hero" alt="octant-asset:hero">',
      ),
      "cart",
      [
        {
          assetId: "hero" as never,
          status: "resolved",
          mediaType: "image/png",
          data: "iVBORw0KGgo=",
        },
      ],
    );
    expect(page).toContain("<code>octant-asset:hero</code>");
    expect(page).toContain(
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="octant-asset:hero">',
    );
  });
});
