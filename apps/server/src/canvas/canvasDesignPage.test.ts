import { CANVAS_DESIGN_ASSETS_MAX_BYTES, type CanvasDesignBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import {
  CanvasDesignRunTickets,
  issueSharedDesignRun,
  renderCanvasDesignPage,
} from "./canvasDesignPage";

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

describe("a shared prototype's page", () => {
  const canvasId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  const prototype = {
    blockId: "cart",
    schemaVersion: 18,
    kind: "design",
    title: "Cart",
    size: "phone",
    runsScript: true,
    frames: [
      { frameId: "cart", title: "Cart", html: '<button onclick="add()">Add</button>' },
      { frameId: "paid", title: "Paid", html: "<p>Paid</p>" },
    ],
  };
  const still = { ...prototype, blockId: "still", runsScript: undefined };
  const document = { canvasId, versionId, blocks: [prototype, still] } as never;

  it("is ticketed once for a running design the snapshot holds, from the frame asked for", () => {
    const tickets = new CanvasDesignRunTickets();
    const page = issueSharedDesignRun(tickets, document, {
      blockId: "cart" as never,
      frameId: "paid" as never,
    });
    expect(page).toMatch(/^\/api\/canvas\/design-page\?ticket=[A-Za-z0-9_-]{43}$/);
    const grant = tickets.redeem(page?.split("ticket=")[1] ?? "");
    expect(grant).toMatchObject({ canvasId, versionId, blockId: "cart", startFrameId: "paid" });
    // A shared design names no image and so needs no authority to resolve one.
    expect(grant?.provenance).toBeUndefined();
    expect(grant?.block.assets).toBeUndefined();
    // The ticket opened once.
    expect(tickets.redeem(page?.split("ticket=")[1] ?? "")).toBeUndefined();
  });

  it("is not offered for a static design, an unknown block, an unknown frame, or a host without tickets", () => {
    const tickets = new CanvasDesignRunTickets();
    expect(issueSharedDesignRun(tickets, document, { blockId: "still" as never })).toBeUndefined();
    expect(issueSharedDesignRun(tickets, document, { blockId: "gone" as never })).toBeUndefined();
    expect(
      issueSharedDesignRun(tickets, document, {
        blockId: "cart" as never,
        frameId: "nowhere" as never,
      }),
    ).toBeUndefined();
    expect(issueSharedDesignRun(undefined, document, { blockId: "cart" as never })).toBeUndefined();
  });
});
