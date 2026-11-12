import { CANVAS_DESIGN_ASSETS_MAX_BYTES, type CanvasDesignBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import {
  CANVAS_DESIGN_EXPORT_RUNNING_POLICY,
  CANVAS_DESIGN_PAGE_POLICY,
  CanvasDesignRunTickets,
  canvasDesignPageHeaders,
  canvasDesignPageNetworkBase,
  issueSharedDesignRun,
  renderCanvasDesignExportFrames,
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

describe("a running design's page with its Canvas's network on", () => {
  const base = canvasDesignPageNetworkBase("http://127.0.0.1:4455", "t".repeat(43));

  it("names its own proxy path for a script's requests and leaves every other directive alone", () => {
    expect(base).toBe(`http://127.0.0.1:4455/api/canvas/network/${"t".repeat(43)}/`);
    const policy = canvasDesignPageHeaders("text/html", base)["content-security-policy"] ?? "";
    expect(policy.split("; ")).toEqual(
      CANVAS_DESIGN_PAGE_POLICY.split("; ").map((directive) =>
        directive === "connect-src 'none'" ? `connect-src ${base}` : directive,
      ),
    );
    // Without a base, the page keeps the policy that names nothing.
    expect(canvasDesignPageHeaders("text/html")["content-security-policy"]).toBe(
      CANVAS_DESIGN_PAGE_POLICY,
    );
  });

  it("routes a fetch through the proxy path only when the host hands the page one", () => {
    const block = checkout("<p>Cart</p><script>function pay() {}</script>");
    expect(renderCanvasDesignPage(block, "cart", [])).not.toContain("/api/canvas/network/");
    const page = renderCanvasDesignPage(block, "cart", [], base);
    expect(page).toContain(JSON.stringify(`${base}fetch?url=`));
    expect(page.indexOf(base)).toBeLessThan(page.indexOf("function pay()"));
  });

  it("sends a page's fetch of another address to the proxy as a bare GET, and offers no other method", async () => {
    const page = renderCanvasDesignPage(checkout("<p>Cart</p>"), "cart", [], base);
    const script = page.split("<script>")[2]?.split("</script>")[0] ?? "";
    const calls: Array<readonly [unknown, unknown]> = [];
    const pageWindow = {
      fetch: (input: unknown, init?: unknown): Promise<unknown> => {
        calls.push([input, init]);
        return Promise.resolve("answered");
      },
    };
    // The host's script, run as the page would run it.
    new Function("window", "document", "location", script)(
      pageWindow,
      { baseURI: "http://127.0.0.1:4455/api/canvas/design-page?ticket=x" },
      { origin: "http://127.0.0.1:4455" },
    );

    await pageWindow.fetch("https://api.example.com/v1?q=a b", {
      headers: { authorization: "Bearer page-secret" },
      credentials: "include",
    });
    expect(calls[0]?.[0]).toBe(
      `${base}fetch?url=${encodeURIComponent("https://api.example.com/v1?q=a%20b")}`,
    );
    expect(calls[0]?.[1]).toEqual({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: undefined,
    });

    await expect(
      pageWindow.fetch("https://api.example.com/", { method: "POST", body: "x" }),
    ).rejects.toThrow(/GET requests only/);
    expect(calls).toHaveLength(1);

    // An address on the host itself is left as asked; the page's policy
    // admits only the proxy path there.
    await pageWindow.fetch("/api/canvas/get");
    expect(calls[1]?.[0]).toBe("/api/canvas/get");
  });

  it("is never the policy an exported file carries", () => {
    expect(CANVAS_DESIGN_EXPORT_RUNNING_POLICY).toContain("connect-src 'none'");
    expect(CANVAS_DESIGN_EXPORT_RUNNING_POLICY).not.toContain("/api/canvas/network/");
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
    // A share never carries the sharer's "Allow network": a reader's page
    // can ask this host to fetch nothing.
    expect(grant?.network).toBeUndefined();
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

describe("a brand design's export", () => {
  const branded = (brand: Record<string, string>): CanvasDesignBlock =>
    ({
      blockId: "site",
      kind: "design",
      title: "Site",
      size: "desktop",
      theme: "brand",
      brand,
      frames: [{ frameId: "home", title: "Home", html: '<div class="oct-card">Hello</div>' }],
    }) as unknown as CanvasDesignBlock;

  it("draws the brand tokens and the frame kit without any window's theme", () => {
    const frames = renderCanvasDesignExportFrames(
      branded({ "color-primary": "#0a7d5a", "font-heading": "georgia, serif" }),
    );
    const page = frames?.[0]?.page ?? "";
    expect(page).toContain("--brand-color-primary: #0a7d5a;");
    expect(page).toContain("--oct-accent: #0a7d5a;");
    expect(page).toContain("--brand-font-heading: georgia, serif;");
    expect(page).toContain(".oct-card");
    expect(page).toContain('class="oct-card"');
  });

  it("never writes a brand value that could close the rule or load something", () => {
    const page =
      renderCanvasDesignExportFrames(
        branded({
          "color-primary": "red; } body { display: none",
          "color-secondary": "url(https://example.com/a.png)",
          "radius-card": "12px",
        }),
      )?.[0]?.page ?? "";
    expect(page).not.toContain("red; }");
    expect(page).not.toContain("--brand-color-primary");
    expect(page).not.toContain("example.com");
    expect(page).toContain("--brand-radius-card: 12px;");
  });
});
