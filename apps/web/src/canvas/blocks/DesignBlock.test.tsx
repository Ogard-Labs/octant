import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  CANVAS_DESIGN_VIEWPORT,
  decodeCanvasBlock,
  decodeCanvasId,
  type CanvasDesignBlock,
} from "@octant/contracts/canvas";
import {
  launchDeckExampleBlock,
  onboardingFlowExampleBlock,
  searchSpecExampleBlock,
} from "@octant/domain";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";
import { designAssetPlaceholder, type DesignAssetRuntime } from "./designDocument";
import {
  designRunRuntimeFor,
  readDesignBridgeMessage,
  RUNNING_DESIGN_FIRST_HEARTBEAT_MS,
  RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS,
  RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND,
  type DesignRunRuntime,
} from "./designRunningFrame";

const PAGE = `http://127.0.0.1:3773/api/canvas/design-page?ticket=${"a".repeat(43)}`;

function prototype(size: CanvasDesignBlock["size"] = "phone"): CanvasDesignBlock {
  const block = decodeCanvasBlock({
    blockId: "checkout",
    schemaVersion: 18,
    kind: "design",
    title: "Checkout",
    size,
    runsScript: true,
    frames: [
      {
        frameId: "cart",
        title: "Cart",
        html: '<p id="n">0</p><button onclick="n.textContent = String(Number(n.textContent) + 1)">Add</button>',
      },
    ],
  });
  if (block.kind !== "design") throw new Error("Fixture is not a design.");
  return block;
}

function staticWindow(screens: number): CanvasDesignBlock {
  const block = decodeCanvasBlock({
    blockId: "window",
    schemaVersion: 9,
    kind: "design",
    title: "Window",
    size: "desktop",
    frames: Array.from({ length: screens }, (_, index) => ({
      frameId: `screen-${String(index)}`,
      title: `Screen ${String(index + 1)}`,
      html: "<p>Home</p>",
    })),
  });
  if (block.kind !== "design") throw new Error("Fixture is not a design.");
  return block;
}

function runRuntime(fields: Partial<DesignRunRuntime> = {}) {
  const start = vi.fn<DesignRunRuntime["start"]>(async () => ({ kind: "ready", url: PAGE }));
  return {
    start,
    runtime: { start, contained: false, drawnIn: "frame" as const, runsOnOpen: false, ...fields },
  };
}

/**
 * The desktop's prototype host as the renderer sees it: what it was asked to
 * open, the input it was sent, and a way to report events for a prototype.
 */
const prototypeHost = {
  listeners: new Set<(event: unknown) => void>(),
  opened: [] as Array<{ readonly surfaceId: string; readonly src: string }>,
  closed: [] as Array<string>,
  drawn: [] as Array<string>,
  inputs: [] as Array<Record<string, unknown>>,
  emit(event: Record<string, unknown>) {
    for (const listener of this.listeners) listener(event);
  },
  reset() {
    this.listeners.clear();
    this.opened.length = 0;
    this.closed.length = 0;
    this.drawn.length = 0;
    this.inputs.length = 0;
  },
};

/** What the prototype host reports for the latest page, or for another surface. */
function surfaceBridge(data: Record<string, unknown>, surfaceId?: string) {
  prototypeHost.emit({
    kind: "bridge",
    surfaceId: surfaceId ?? prototypeHost.opened.at(-1)?.surfaceId,
    payload: { channel: "octant-design-frame@1", ...data },
  });
}

function views(container: ParentNode): ReadonlyArray<Element> {
  return Array.from(container.querySelectorAll("canvas[aria-roledescription='running prototype']"));
}

function installDesktopBridge(fields: Record<string, unknown> = {}) {
  (window as { octantHost?: unknown }).octantHost = {
    openCanvasPrototype: async (request: { readonly surfaceId: string; readonly src: string }) => {
      prototypeHost.opened.push(request);
      return { status: "open" };
    },
    subscribeCanvasPrototypeEvents: (listener: (event: unknown) => void) => {
      prototypeHost.listeners.add(listener);
      return () => prototypeHost.listeners.delete(listener);
    },
    sendCanvasPrototypeInput: async (_surfaceId: string, input: Record<string, unknown>) => {
      prototypeHost.inputs.push(input);
    },
    resizeCanvasPrototype: async () => undefined,
    acknowledgeCanvasPrototypeFrame: async (surfaceId: string) => {
      prototypeHost.drawn.push(surfaceId);
    },
    closeCanvasPrototype: async (surfaceId: string) => {
      prototypeHost.closed.push(surfaceId);
    },
    setProviderCredential: () => undefined,
    providerCredentialStatus: () => undefined,
    clearProviderCredential: () => undefined,
    listProviderApiKeys: () => undefined,
    addProviderApiKey: () => undefined,
    renameProviderApiKey: () => undefined,
    replaceProviderApiKey: () => undefined,
    removeProviderApiKey: () => undefined,
    setActiveProviderApiKey: () => undefined,
    moveProviderApiKey: () => undefined,
    ...fields,
  };
}

function bridge(frame: HTMLIFrameElement, data: Record<string, unknown>, source?: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { channel: "octant-design-frame@1", ...data },
      origin: "null",
      source: (source ?? frame.contentWindow) as Window,
    }),
  );
}

function frames(container: ParentNode): ReadonlyArray<HTMLIFrameElement> {
  return Array.from(container.querySelectorAll("iframe"));
}

function design(fields: Partial<Pick<CanvasDesignBlock, "size" | "theme">>): CanvasDesignBlock {
  const block = decodeCanvasBlock({ ...onboardingFlowExampleBlock, ...fields });
  if (block.kind !== "design") throw new Error("Fixture is not a design.");
  return block;
}

/** A deck long enough that drawing every slide at once would be felt. */
function deck(slides: number): CanvasDesignBlock {
  const block = decodeCanvasBlock({
    ...launchDeckExampleBlock,
    frames: Array.from({ length: slides }, (_, index) => ({
      frameId: `slide-${String(index + 1)}`,
      title: `Slide ${String(index + 1)}`,
      html: `<section class="slide"><h2>Slide ${String(index + 1)}</h2></section>`,
    })),
  });
  if (block.kind !== "design") throw new Error("Fixture is not a design.");
  return block;
}

/**
 * Layout, which jsdom has none of: a board the test gives a width, and a
 * viewport the test scrolls figures into. Each stub records what is watched
 * and lets the test report for it.
 */
function stubLayoutObservers() {
  const boards: Array<{ element: Element; report: (width: number) => void }> = [];
  const watched: Array<Element> = [];
  let reveal: (entries: ReadonlyArray<{ target: Element; isIntersecting: boolean }>) => void = () =>
    undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
      }
      observe(element: Element) {
        boards.push({
          element,
          report: (width) =>
            this.#callback(
              [{ target: element, contentRect: { width, height: 0 } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            ),
        });
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        reveal = (entries) =>
          callback(
            entries as unknown as Array<IntersectionObserverEntry>,
            this as unknown as IntersectionObserver,
          );
      }
      observe(element: Element) {
        watched.push(element);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return {
    boards,
    watched,
    scrollTo: (elements: ReadonlyArray<Element>) =>
      reveal(elements.map((target) => ({ target, isIntersecting: true }))),
  };
}

function figures(container: ParentNode): ReadonlyArray<HTMLElement> {
  return Array.from(container.querySelectorAll<HTMLElement>(".canvas-design__frame"));
}

function previews(container: ParentNode): ReadonlyArray<HTMLElement> {
  return Array.from(container.querySelectorAll<HTMLElement>(".canvas-design__preview"));
}

function scaleOf(frame: HTMLIFrameElement): number {
  const match = /scale\(([\d.]+)\)/.exec(frame.style.transform);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as { octantHost?: unknown }).octantHost;
  prototypeHost.reset();
  const root = document.documentElement;
  delete root.dataset.octantThemeMode;
  root.style.removeProperty("--oct-fg");
});

describe("design block", () => {
  it("draws every screen in a frame that runs nothing and loads nothing", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [onboardingFlowExampleBlock] }} />,
    );

    const design = screen.getByRole("region", { name: "Onboarding, Phone design" });
    expect(within(design).getByText("Phone · 2 screens")).toBeVisible();
    const pages = frames(design);
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      // An empty sandbox grants no script, form, popup, or same-origin access.
      expect(page.getAttribute("sandbox")).toBe("");
      expect(page).toHaveAttribute("tabindex", "-1");
      expect(page.srcdoc).toContain(
        `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"`,
      );
    }
    expect(pages[0]?.srcdoc).toContain("Dinner from the places your street already loves.");
    expect(pages[0]?.srcdoc).not.toContain("Where should we deliver?");
    expect(pages[0]).toHaveAttribute("title", "Welcome, Phone screen");
  });

  it("shows a Project screenshot in a phone mockup and a placeholder for an image the host refused, loading nothing", async () => {
    const block = decodeCanvasBlock({
      blockId: "phone",
      schemaVersion: 17,
      kind: "design",
      title: "Mockup",
      size: "phone",
      styles: ".brand { background: url(octant-asset:logo); }",
      assets: [
        { assetId: "shot", source: { kind: "project-file", path: "screens/home.png" } },
        { assetId: "logo", source: { kind: "project-file", path: "../outside.png" } },
      ],
      frames: [
        {
          frameId: "home",
          title: "Home",
          html: '<img src="octant-asset:shot" alt="Home"><div class="brand"></div>',
        },
      ],
    });
    const resolve = vi.fn<DesignAssetRuntime["resolve"]>(
      async () =>
        [
          { assetId: "shot", status: "resolved", mediaType: "image/png", data: "iVBORw0KGgo=" },
          { assetId: "logo", status: "unavailable", reason: "refused" },
        ] as never,
    );
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [block] }}
        designAssetRuntime={{ resolve }}
      />,
    );
    const page = frames(document.body)[0];
    // Until the host answers, the image is a placeholder that says so.
    expect(page?.srcdoc).toContain(designAssetPlaceholder("shot", "loading"));
    await act(async () => {});

    expect(resolve).toHaveBeenCalledWith("phone");
    const drawn = frames(document.body)[0]?.srcdoc ?? "";
    expect(drawn).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="Home">');
    expect(drawn).toContain(`url(${designAssetPlaceholder("logo", "refused")})`);
    expect(drawn).not.toContain("octant-asset:");
    expect(drawn).toContain("img-src data:;");
  });

  it("draws every declared image as a placeholder where no host can resolve it", () => {
    const block = decodeCanvasBlock({
      blockId: "phone",
      schemaVersion: 17,
      kind: "design",
      title: "Mockup",
      size: "phone",
      assets: [{ assetId: "shot", source: { kind: "project-file", path: "a.png" } }],
      frames: [{ frameId: "home", title: "Home", html: '<img src="octant-asset:shot" alt="">' }],
    });
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [block] }} />);
    const drawn = frames(document.body)[0]?.srcdoc ?? "";
    expect(drawn).toContain(designAssetPlaceholder("shot", "not-loaded"));
    expect(drawn).not.toContain("octant-asset:");
  });

  it("replaces an asset reference only where an image is loaded, leaving prose and other attributes as written", () => {
    const block = decodeCanvasBlock({
      blockId: "phone",
      schemaVersion: 17,
      kind: "design",
      title: "Mockup",
      size: "phone",
      styles: '.hero { background: image-set("octant-asset:shot" 1x); }',
      assets: [{ assetId: "shot", source: { kind: "project-file", path: "a.png" } }],
      frames: [
        {
          frameId: "home",
          title: "Home",
          html: [
            "<p>Name it <code>octant-asset:shot</code>.</p>",
            '<img src="octant-asset:shot" alt="octant-asset:shot" data-note="octant-asset:shot"',
            ' srcset="data:image/png;base64,AA 1x, octant-asset:shot 2x">',
            "<div style=\"background: url('octant-asset:shot')\"></div>",
          ].join(""),
        },
      ],
    });
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [block] }} />);
    const drawn = frames(document.body)[0]?.srcdoc ?? "";
    const image = designAssetPlaceholder("shot", "not-loaded");
    expect(drawn).toContain("<code>octant-asset:shot</code>");
    expect(drawn).toContain(
      `<img src="${image}" alt="octant-asset:shot" data-note="octant-asset:shot"`,
    );
    expect(drawn).toContain(`srcset="data:image/png;base64,AA 1x, ${image} 2x"`);
    expect(drawn).toContain(`url('${image}')`);
    expect(drawn).toContain(`image-set("${image}" 1x)`);
  });

  it("plays the whole flow from the screen a person picks, so its links work", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [onboardingFlowExampleBlock] }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Play from Address" }));

    const player = screen.getByRole("dialog", { name: "Playing Onboarding" });
    const prototype = within(player).getByTitle("Onboarding, prototype") as HTMLIFrameElement;
    expect(prototype.getAttribute("sandbox")).toBe("");
    expect(prototype).not.toHaveAttribute("tabindex");
    // Both screens are in one page so `href="#address"` can reach the other.
    expect(prototype.srcdoc).toContain('<div class="octant-frame" id="welcome">');
    expect(prototype.srcdoc).toContain('<div class="octant-frame" id="address" data-start>');
    // A bare `#address` in a srcdoc page resolves against Octant's own address
    // and blanks the frame; the link must name the page itself.
    expect(prototype.srcdoc).toContain('href="about:srcdoc#address"');
    expect(prototype.srcdoc).not.toContain('href="#address"');
  });

  it("draws a lone desktop window large on the board, and a row of desktop screens as thumbnails", () => {
    const { container, rerender } = render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [staticWindow(1)] }} />,
    );
    // The stylesheet draws each box as wide as the board allows, up to this cap.
    const previewWidth = () =>
      (container.querySelector(".canvas-design__frame") as HTMLElement).style.getPropertyValue(
        "--canvas-design-frame-cap",
      );
    expect(previewWidth()).toBe(`${String(CANVAS_DESIGN_VIEWPORT.desktop.width)}px`);

    rerender(<CanvasDocument definition={{ ...canvasFixture, blocks: [staticWindow(2)] }} />);
    expect(previewWidth()).toBe("440px");
  });

  describe("full screen", () => {
    const original = Object.getOwnPropertyDescriptor(document, "fullscreenEnabled");
    afterEach(() => {
      if (original === undefined) {
        delete (document as { fullscreenEnabled?: unknown }).fullscreenEnabled;
      } else Object.defineProperty(document, "fullscreenEnabled", original);
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    });

    function allowFullscreen() {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
      const request = vi.fn(async () => undefined);
      HTMLElement.prototype.requestFullscreen = request;
      return request;
    }

    function enter(element: Element | null) {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: element });
      act(() => {
        document.dispatchEvent(new Event("fullscreenchange"));
      });
    }

    it("plays a design full screen where the browser allows it, and offers the way back", () => {
      const request = allowFullscreen();
      render(<CanvasDocument definition={{ ...canvasFixture, blocks: [staticWindow(1)] }} />);
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      const player = screen.getByRole("dialog", { name: "Playing Window" });

      fireEvent.click(within(player).getByRole("button", { name: "Full screen" }));

      const body = player.querySelector(".canvas-design-player__body");
      expect(request.mock.contexts[0]).toBe(body);
      enter(body);
      expect(within(player).getByRole("button", { name: "Exit full screen" })).toBeVisible();
    });

    it("runs a desktop prototype full screen with Stop still reachable", async () => {
      const request = allowFullscreen();
      const { runtime } = runRuntime();
      render(
        <CanvasDocument
          definition={{ ...canvasFixture, blocks: [prototype("desktop")] }}
          designRunRuntime={runtime}
          placement="thread"
        />,
      );
      const region = screen.getByRole("region", { name: "Checkout, Desktop prototype" });
      expect(within(region).queryByRole("button", { name: "Full screen" })).toBeNull();
      fireEvent.click(within(region).getByRole("button", { name: "Run" }));
      await within(region).findByTitle("Checkout, running prototype");

      fireEvent.click(within(region).getByRole("button", { name: "Full screen" }));

      expect(request.mock.contexts[0]).toBe(region);
      enter(region);
      expect(within(region).getByRole("button", { name: "Exit full screen" })).toBeVisible();
      expect(within(region).getByRole("button", { name: "Stop" })).toBeVisible();

      // Stopping leaves the section full screen, so the way back stays.
      fireEvent.click(within(region).getByRole("button", { name: "Stop" }));
      expect(within(region).getByRole("button", { name: "Exit full screen" })).toBeVisible();
    });

    it("offers no full screen button where the browser cannot", () => {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: false });
      render(<CanvasDocument definition={{ ...canvasFixture, blocks: [staticWindow(1)] }} />);
      fireEvent.click(screen.getByRole("button", { name: "Play" }));

      expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
    });
  });

  it("presents slides in order and moves with the arrow keys", () => {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [launchDeckExampleBlock] }} />);

    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    const player = screen.getByRole("dialog", { name: "Presenting Launch plan" });
    expect(within(player).getByText("1 / 2")).toBeVisible();
    expect(within(player).getByRole("button", { name: "Previous slide" })).toBeDisabled();

    fireEvent.keyDown(within(player).getByRole("button", { name: "Next slide" }), {
      key: "ArrowRight",
    });
    expect(within(player).getByText("2 / 2")).toBeVisible();
    expect(within(player).getByTitle("Goals, slide 2")).toHaveAttribute("tabindex", "-1");
    expect(within(player).getByRole("button", { name: "Next slide" })).toBeDisabled();
  });

  it("draws every slide no wider than the column it sits in, and sizes its box before the column is measured", () => {
    const layout = stubLayoutObservers();
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [deck(3)] }} />);
    const board = screen.getByRole("region", { name: "Launch plan, Slide design" });
    layout.scrollTo(layout.watched);

    // Before the board is measured, each box already has the slide's shape
    // and the width the stylesheet caps at the board; the page waits.
    expect(figures(board)).toHaveLength(3);
    for (const figure of figures(board)) {
      expect(figure.style.getPropertyValue("--canvas-design-frame-cap")).toBe("440px");
      expect(figure.style.width).toBe("");
    }
    for (const preview of previews(board)) expect(preview.style.aspectRatio).toBe("1920 / 1080");
    expect(frames(board)).toHaveLength(0);

    // A side panel narrower than a slide's full board width.
    act(() => layout.boards[0]?.report(320));
    expect(frames(board)).toHaveLength(3);
    for (const page of frames(board)) {
      expect(scaleOf(page) * CANVAS_DESIGN_VIEWPORT.slide.width).toBeLessThanOrEqual(320);
    }

    // A full tab: the cap, not the board, bounds a slide.
    act(() => layout.boards[0]?.report(1200));
    for (const page of frames(board)) {
      expect(scaleOf(page) * CANVAS_DESIGN_VIEWPORT.slide.width).toBeCloseTo(440);
    }
  });

  it("loads a slide's page only when the slide or its neighbour is near the visible part of the board", () => {
    const layout = stubLayoutObservers();
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [deck(12)] }} />);
    const board = screen.getByRole("region", { name: "Launch plan, Slide design" });
    act(() => layout.boards[0]?.report(640));

    // Every slide has its box and caption; no page has loaded yet.
    expect(previews(board)).toHaveLength(12);
    expect(within(board).getByText("Slide 12")).toBeInTheDocument();
    expect(frames(board)).toHaveLength(0);
    expect(layout.watched).toHaveLength(12);

    // The first two slides scroll into view: they and the slide after them load.
    act(() => layout.scrollTo(layout.watched.slice(0, 2)));
    const loaded = frames(board);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((page) => page.title)).toEqual([
      "Slide 1, Slide slide",
      "Slide 2, Slide slide",
      "Slide 3, Slide slide",
    ]);
    expect(loaded[0]?.srcdoc).toContain("<h2>Slide 1</h2>");

    // Scrolling on loads more, and a slide once loaded stays loaded.
    act(() => layout.scrollTo(layout.watched.slice(6, 7)));
    expect(frames(board).map((page) => page.title)).toEqual([
      "Slide 1, Slide slide",
      "Slide 2, Slide slide",
      "Slide 3, Slide slide",
      "Slide 6, Slide slide",
      "Slide 7, Slide slide",
      "Slide 8, Slide slide",
    ]);
  });

  it("presents every slide of a long deck in turn, keeping only the neighbours loaded", () => {
    stubLayoutObservers();
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [deck(12)] }} />);

    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    const player = screen.getByRole("dialog", { name: "Presenting Launch plan" });
    const next = within(player).getByRole("button", { name: "Next slide" });
    for (let slide = 1; slide <= 12; slide += 1) {
      expect(within(player).getByText(`${String(slide)} / 12`)).toBeVisible();
      const shown = within(player).getByTitle<HTMLIFrameElement>(
        `Slide ${String(slide)}, slide ${String(slide)}`,
      );
      expect(shown).not.toHaveAttribute("hidden");
      expect(shown).not.toHaveAttribute("aria-hidden");
      expect(shown.srcdoc).toContain(`<h2>Slide ${String(slide)}</h2>`);
      const mounted = frames(player);
      expect(mounted.length).toBeLessThanOrEqual(3);
      for (const page of mounted) {
        // A neighbour is drawn beneath the shown page, never display: none,
        // so it is already painted when a step reveals it.
        if (page !== shown) {
          expect(page).not.toHaveAttribute("hidden");
          expect(page).toHaveAttribute("aria-hidden", "true");
          expect(page).toHaveClass("canvas-design__page--beneath");
        }
      }
      if (slide < 12) {
        // The next slide is already loaded, so stepping shows it at once.
        expect(
          within(player).getByTitle(`Slide ${String(slide + 1)}, slide ${String(slide + 1)}`),
        ).toBeInTheDocument();
        fireEvent.keyDown(next, { key: "ArrowRight" });
      }
    }
    expect(next).toBeDisabled();
  });

  it("never draws a frame that may run script beside Octant's own origin", () => {
    // Same origin is safe only for a page that runs nothing; together with
    // script it would hand the page Octant itself. Every size and theme, on the
    // board and in the player, is checked.
    for (const size of ["phone", "tablet", "desktop", "slide", "document"] as const) {
      for (const theme of [undefined, "workspace", "none"] as const) {
        const block = design(theme === undefined ? { size } : { size, theme });
        render(<CanvasDocument definition={{ ...canvasFixture, blocks: [block] }} />);
        const play = screen.queryByRole("button", { name: /^(Play|Present)$/ });
        if (play !== null) fireEvent.click(play);
        const drawn = frames(document);
        expect(drawn.length).toBeGreaterThan(0);
        for (const frame of drawn) {
          const tokens = (frame.getAttribute("sandbox") ?? "missing").split(/\s+/).filter(Boolean);
          expect(frame.hasAttribute("sandbox")).toBe(true);
          expect(tokens).not.toContain("allow-scripts");
          expect(tokens.every((token) => token === "allow-same-origin")).toBe(true);
          expect(frame.srcdoc).not.toMatch(/<script/i);
        }
        cleanup();
      }
    }
  });

  it("draws a running prototype in a frame sandboxed to script alone, beside static frames that never run script", async () => {
    // The same rule as above, with running frames among them: no frame is
    // ever given both script and Octant's origin, on any size.
    for (const size of ["phone", "tablet", "desktop", "slide", "document"] as const) {
      const { runtime } = runRuntime({ runsOnOpen: true });
      render(
        <CanvasDocument
          definition={{
            ...canvasFixture,
            blocks: [prototype(size), onboardingFlowExampleBlock, searchSpecExampleBlock],
          }}
          designRunRuntime={runtime}
        />,
      );
      const running = await screen.findByTitle("Checkout, running prototype");
      expect(running.getAttribute("sandbox")).toBe("allow-scripts");
      expect(running.getAttribute("src")).toBe(PAGE);
      expect(running).toHaveAttribute("referrerpolicy", "no-referrer");
      const drawn = frames(document);
      expect(drawn.length).toBeGreaterThan(2);
      for (const frame of drawn) {
        expect(frame.hasAttribute("sandbox")).toBe(true);
        const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
        expect(tokens.includes("allow-scripts") && tokens.includes("allow-same-origin")).toBe(
          false,
        );
        for (const token of tokens) {
          expect(["allow-scripts", "allow-same-origin"]).toContain(token);
        }
      }
      cleanup();
    }
  });

  it("reads a document in place in the workspace theme, with the frame kit and no inner scrollbar", async () => {
    const root = document.documentElement;
    root.dataset.octantThemeMode = "dark";
    root.style.setProperty("--oct-fg", "rgb(240, 240, 240)");
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [searchSpecExampleBlock] }} />);

    const article = screen.getByRole("region", { name: "Search ranking spec, document" });
    expect(within(article).queryByRole("button", { name: "Play" })).toBeNull();
    const [page, ...others] = frames(article);
    expect(others).toHaveLength(0);
    expect(page?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(page).not.toHaveAttribute("tabindex");
    expect(page).toHaveAttribute("title", "Search ranking spec, document");
    const srcdoc = page?.srcdoc ?? "";
    expect(srcdoc).toContain(
      `content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"`,
    );
    expect(srcdoc).toContain('<meta name="viewport" content="width=device-width">');
    expect(srcdoc).toContain("color-scheme: dark;");
    expect(srcdoc).toContain("--oct-fg: rgb(240, 240, 240);");
    expect(srcdoc).toContain(".oct-tabs > input:nth-of-type(1):checked");
    expect(srcdoc).not.toContain("background: white");
    // The page grows to its content rather than filling a fixed screen.
    expect(srcdoc).not.toContain("min-height: 100vh");

    // A theme change redraws the page in the new scheme.
    await act(async () => {
      root.dataset.octantThemeMode = "light";
      await Promise.resolve();
    });
    expect(frames(article)[0]?.srcdoc).toContain("color-scheme: light;");
  });

  it("redraws a document in high contrast when Increased contrast turns on, and back when it turns off", async () => {
    // The Settings toggle and the system preference publish one root
    // attribute, and the stylesheet swaps the text roles under it, so the
    // attribute is the only thing that moves besides the computed tokens.
    const root = document.documentElement;
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computedStyle(element, pseudo);
      if (element !== root) return style;
      const foreground =
        root.dataset.octantIncreasedContrast === "true"
          ? "rgb(255, 255, 255)"
          : "rgb(240, 240, 240)";
      return new Proxy(style, {
        get: (target, key) =>
          key === "getPropertyValue"
            ? (name: string) => (name === "--oct-fg" ? foreground : target.getPropertyValue(name))
            : Reflect.get(target, key, target),
      });
    });
    try {
      render(
        <CanvasDocument definition={{ ...canvasFixture, blocks: [searchSpecExampleBlock] }} />,
      );
      const article = screen.getByRole("region", { name: "Search ranking spec, document" });
      expect(frames(article)[0]?.srcdoc).toContain("--oct-fg: rgb(240, 240, 240);");

      await act(async () => {
        root.dataset.octantIncreasedContrast = "true";
        await Promise.resolve();
      });
      expect(frames(article)[0]?.srcdoc).toContain("--oct-fg: rgb(255, 255, 255);");

      await act(async () => {
        root.dataset.octantIncreasedContrast = "false";
        await Promise.resolve();
      });
      expect(frames(article)[0]?.srcdoc).toContain("--oct-fg: rgb(240, 240, 240);");
    } finally {
      vi.restoreAllMocks();
      delete root.dataset.octantIncreasedContrast;
    }
  });

  it("keeps a phone design unthemed at its device size unless it asks for the theme", () => {
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: [onboardingFlowExampleBlock] }} />,
    );
    const [screenFrame] = frames(screen.getByRole("region", { name: "Onboarding, Phone design" }));
    expect(screenFrame?.getAttribute("sandbox")).toBe("");
    expect(screenFrame?.style.width).toBe("390px");
    expect(screenFrame?.srcdoc).toContain("color-scheme: light; background: white; color: black;");
    expect(screenFrame?.srcdoc).not.toContain(".oct-tabs");
    cleanup();

    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [design({ theme: "workspace" })] }}
      />,
    );
    const [themed] = frames(screen.getByRole("region", { name: "Onboarding, Phone design" }));
    expect(themed?.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(themed?.srcdoc).toContain(".oct-tabs");
    expect(themed?.srcdoc).toContain("background: var(--oct-bg);");
  });
});

describe("running prototype", () => {
  it("starts in the thread only when the person presses Run, and says where it is not network-contained", async () => {
    const { start, runtime } = runRuntime({ contained: false });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
        placement="thread"
      />,
    );
    const region = screen.getByRole("region", { name: "Checkout, Phone prototype" });
    expect(frames(region)).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
    expect(within(region).getByText(/not network-contained/)).toBeVisible();
    expect(within(region).getByText(/can still connect to another computer/)).toBeVisible();

    fireEvent.click(within(region).getByRole("button", { name: "Run" }));
    const frame = await within(region).findByTitle("Checkout, running prototype");
    expect(start).toHaveBeenCalledWith("checkout");
    expect(frame).not.toHaveAttribute("tabindex");
    expect(within(region).getByRole("status")).toHaveTextContent("Running");
    expect(within(region).queryByText(/not network-contained/)).toBeNull();

    fireEvent.click(within(region).getByRole("button", { name: "Stop" }));
    expect(frames(region)).toHaveLength(0);
    expect(within(region).getByRole("button", { name: "Run again" })).toBeVisible();
  });

  it("runs on open in the sidebar without taking focus, reachable by Tab, and in the desktop app says it has no network", async () => {
    installDesktopBridge({ prepareCanvasPrototypeSurface: async () => ({ status: "ready" }) });
    const { start, runtime } = runRuntime({
      runsOnOpen: true,
      contained: true,
      drawnIn: "desktop-surface",
    });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    const view = await screen.findByTitle("Checkout, running prototype");
    expect(start).toHaveBeenCalledOnce();
    expect(view.tagName).toBe("CANVAS");
    // Reachable by Tab, but opening did not move focus into it.
    expect(view).toHaveAttribute("tabindex", "0");
    expect(document.activeElement).toBe(document.body);
    // The desktop draws it from the prototype host, never in a frame.
    expect(frames(document)).toHaveLength(0);
    expect(screen.queryByText(/not network-contained/)).toBeNull();
    expect(screen.queryByText(/can still connect to another computer/)).toBeNull();
    expect(screen.getByText(/no network connection/)).toBeVisible();
    expect(screen.queryByText(/look up host names/)).toBeNull();
  });

  it("leaves a prototype that started by itself in the tab order, right after Stop, without opening it there", async () => {
    const { runtime } = runRuntime({ runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    const frame = await screen.findByTitle("Checkout, running prototype");
    expect(frame.tagName).toBe("IFRAME");
    expect(document.activeElement).toBe(document.body);
    // An iframe is focusable by default; jsdom cannot move Tab into one, so the
    // contract is that nothing takes it out of the order (a negative tabindex
    // did), and that Stop is the control just before it.
    expect(frame.tabIndex).toBeGreaterThanOrEqual(0);
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cannot run where the host serves no prototypes, and shows why a refused run stopped", async () => {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [prototype()] }} />);
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.getByText(/runs only in Octant/)).toBeVisible();
    cleanup();

    const { runtime } = runRuntime({
      start: async () => ({
        kind: "refused",
        reason: "That prototype is not in this Canvas version.",
      }),
    });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("That prototype is not in this Canvas version.")).toBeVisible();
    expect(frames(document)).toHaveLength(0);
  });

  it("removes a frame that stops sending its heartbeat and offers to run it again", async () => {
    vi.useFakeTimers();
    const { runtime } = runRuntime({ runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const frame = screen.getByTitle<HTMLIFrameElement>("Checkout, running prototype");
    fireEvent.load(frame);

    // A page that keeps beating keeps running well past the allowance.
    for (let second = 0; second < 12; second += 1) {
      act(() => {
        bridge(frame, { type: "heartbeat" });
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(frames(document)).toHaveLength(1);

    // Beats from any other window do not keep it alive.
    for (let second = 0; second <= RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS / 1_000 + 1; second += 1) {
      act(() => {
        bridge(frame, { type: "heartbeat" }, window);
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(frames(document)).toHaveLength(0);
    expect(screen.getByText(/stopped responding/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run again" })).toBeVisible();
  });

  it("gives a new page time for its first heartbeat, then stops it", async () => {
    vi.useFakeTimers();
    const { runtime } = runRuntime({ runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS + 1_000));
    expect(frames(document)).toHaveLength(1);
    act(() => vi.advanceTimersByTime(RUNNING_DESIGN_FIRST_HEARTBEAT_MS));
    expect(frames(document)).toHaveLength(0);
  });

  it("removes a frame that floods the bridge, so the person can still press Stop", async () => {
    vi.useFakeTimers();
    const { runtime } = runRuntime({ runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype("document")] }}
        designRunRuntime={runtime}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const frame = screen.getByTitle<HTMLIFrameElement>("Checkout, running prototype");
    // A busy page that resizes and fails every animation frame keeps running.
    for (let second = 0; second < 3; second += 1) {
      act(() => {
        for (let tick = 0; tick < 60; tick += 1) {
          bridge(frame, { type: "size", height: 400 + tick });
          bridge(frame, { type: "error", message: "boom" });
        }
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(frames(document)).toHaveLength(1);

    act(() => {
      for (let sent = 0; sent <= RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND; sent += 1) {
        bridge(frame, { type: "error", message: `boom ${String(sent)}` });
      }
    });
    expect(frames(document)).toHaveLength(0);
    expect(screen.getByText(/sent too many messages/)).toBeVisible();
  });

  it("removes a frame that loads a second page", async () => {
    const { runtime } = runRuntime({ runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    const frame = await screen.findByTitle("Checkout, running prototype");
    fireEvent.load(frame);
    expect(frames(document)).toHaveLength(1);
    fireEvent.load(frame);
    expect(frames(document)).toHaveLength(0);
    expect(screen.getByText(/tried to load another page/)).toBeVisible();
  });

  it("sizes a running document from its bridge within bounds, and shows its script errors as text", async () => {
    const { runtime } = runRuntime({ runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype("document")] }}
        designRunRuntime={runtime}
      />,
    );
    // The frame listens for its bridge from an effect, so the start settles
    // inside act: waiting for the frame alone returned before that effect ran
    // on a loaded machine, and the first message was posted to nobody.
    await act(async () => {
      await Promise.resolve();
    });
    const frame = screen.getByTitle<HTMLIFrameElement>("Checkout, running prototype");
    act(() => bridge(frame, { type: "size", height: 640 }));
    expect(frame.style.height).toBe("640px");
    act(() => bridge(frame, { type: "size", height: 10_000_000 }));
    expect(frame.style.height).toBe("12000px");
    // A forged source, a wrong channel, or a wrong shape changes nothing.
    act(() => bridge(frame, { type: "size", height: 300 }, window));
    act(() => bridge(frame, { channel: "other", type: "size", height: 300 }));
    act(() => bridge(frame, { type: "size", height: "300" }));
    expect(frame.style.height).toBe("12000px");

    act(() => bridge(frame, { type: "error", message: `<b>boom</b>${"x".repeat(1_000)}` }));
    const errors = screen.getByRole("list", { name: "Prototype script errors" });
    expect(errors.textContent?.startsWith("<b>boom</b>")).toBe(true);
    expect(errors.querySelector("b")).toBeNull();
    expect(errors.textContent?.length).toBeLessThanOrEqual(280);
  });
});

describe("running prototype in the desktop app", () => {
  function runDesktop(fields: Partial<DesignRunRuntime> = {}, size?: CanvasDesignBlock["size"]) {
    if ((window as { octantHost?: unknown }).octantHost === undefined) {
      installDesktopBridge({ prepareCanvasPrototypeSurface: async () => ({ status: "ready" }) });
    }
    const run = runRuntime({ contained: true, drawnIn: "desktop-surface", ...fields });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype(size)] }}
        designRunRuntime={run.runtime}
      />,
    );
    return run;
  }

  it("opens the host's ticketed page in the prototype host and draws it on a canvas, never in a frame", async () => {
    runDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const view = await screen.findByTitle("Checkout, running prototype");
    expect(view.tagName).toBe("CANVAS");
    expect(prototypeHost.opened).toEqual([
      expect.objectContaining({
        src: PAGE,
        width: CANVAS_DESIGN_VIEWPORT.phone.width,
        height: CANVAS_DESIGN_VIEWPORT.phone.height,
      }),
    ]);
    expect(frames(document)).toHaveLength(0);
    expect(view).toHaveAttribute("tabindex", "0");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await Promise.resolve();
    });
    expect(prototypeHost.closed).toEqual([prototypeHost.opened[0]?.surfaceId]);
  });

  it("answers each frame of its own prototype, drawn or malformed, so the host sends the next", async () => {
    runDesktop({ runsOnOpen: true });
    await act(async () => {
      await Promise.resolve();
    });
    const surfaceId = prototypeHost.opened[0]?.surfaceId;
    const frame = {
      kind: "frame",
      frameWidth: 2,
      frameHeight: 2,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      pixels: new Uint8Array(4),
    };
    act(() => prototypeHost.emit({ ...frame, surfaceId }));
    act(() => prototypeHost.emit({ ...frame, surfaceId, pixels: new Uint8Array(3) }));
    act(() => prototypeHost.emit({ ...frame, surfaceId: "33333333-3333-4333-8333-333333333333" }));
    act(() => prototypeHost.emit({ kind: "cursor", surfaceId, cursor: "pointer" }));
    expect(prototypeHost.drawn).toEqual([surfaceId, surfaceId]);
  });

  it("keeps a prototype running while its page beats, stops it when the beats stop, and offers to run it again", async () => {
    vi.useFakeTimers();
    runDesktop({ runsOnOpen: true });
    await act(async () => {
      await Promise.resolve();
    });
    for (let second = 0; second < 12; second += 1) {
      act(() => {
        surfaceBridge({ type: "heartbeat" });
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(views(document)).toHaveLength(1);

    // Beats for any other prototype keep nothing alive.
    for (let second = 0; second <= RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS / 1_000 + 1; second += 1) {
      act(() => {
        surfaceBridge({ type: "heartbeat" }, "33333333-3333-4333-8333-333333333333");
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/stopped responding/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run again" })).toBeVisible();
    expect(screen.queryByText(/open Octant in a new tab/)).toBeNull();
  });

  it("sizes a running document from its bridge within bounds, ignoring forged messages, and shows its script errors as text", async () => {
    runDesktop({ runsOnOpen: true }, "document");
    await act(async () => {
      await Promise.resolve();
    });
    const view = screen.getByTitle("Checkout, running prototype");
    act(() => surfaceBridge({ type: "size", height: 640 }));
    expect((view as HTMLElement).style.height).toBe("640px");
    act(() => surfaceBridge({ type: "size", height: 10_000_000 }));
    expect((view as HTMLElement).style.height).toBe("12000px");
    act(() => surfaceBridge({ type: "size", height: "300" }));
    act(() => surfaceBridge({ channel: "other", type: "size", height: 300 }));
    act(() => surfaceBridge({ type: "navigate", url: "https://example.test" }));
    act(() => surfaceBridge({ type: "size", height: 300 }, "33333333-3333-4333-8333-333333333333"));
    expect((view as HTMLElement).style.height).toBe("12000px");

    act(() => surfaceBridge({ type: "error", message: `<b>boom</b>${"x".repeat(1_000)}` }));
    const errors = screen.getByRole("list", { name: "Prototype script errors" });
    expect(errors.textContent?.startsWith("<b>boom</b>")).toBe(true);
    expect(errors.querySelector("b")).toBeNull();
    expect(errors.textContent?.length).toBeLessThanOrEqual(280);
  });

  it("scales a device-sized prototype to the column like a frame does", async () => {
    runDesktop({ runsOnOpen: true });
    const view = await screen.findByTitle("Checkout, running prototype");
    expect((view as HTMLElement).style.width).toBe(
      `${String(CANVAS_DESIGN_VIEWPORT.phone.width)}px`,
    );
    expect((view as HTMLElement).style.height).toBe(
      `${String(CANVAS_DESIGN_VIEWPORT.phone.height)}px`,
    );
    expect((view as HTMLElement).style.transform).toBe("scale(1)");
  });

  it("removes a prototype that floods the bridge, so the person can still press Stop", async () => {
    vi.useFakeTimers();
    runDesktop({ runsOnOpen: true }, "document");
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      for (let sent = 0; sent <= RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND; sent += 1) {
        surfaceBridge({ type: "error", message: `boom ${String(sent)}` });
      }
    });
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/sent too many messages/)).toBeVisible();
  });

  it("removes a prototype whose page went away in the prototype host, or that the host would not open", async () => {
    runDesktop({ runsOnOpen: true });
    await screen.findByTitle("Checkout, running prototype");
    act(() => prototypeHost.emit({ kind: "gone", surfaceId: prototypeHost.opened[0]?.surfaceId }));
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/stopped responding/)).toBeVisible();
    cleanup();

    installDesktopBridge({
      prepareCanvasPrototypeSurface: async () => ({ status: "ready" }),
      openCanvasPrototype: async () => ({ status: "refused", reason: "Not this page." }),
    });
    runDesktop({ runsOnOpen: true });
    expect(await screen.findByText(/stopped responding/)).toBeVisible();
    expect(views(document)).toHaveLength(0);
  });

  it("opens the page once when its effect is run twice, as React's development checks do", async () => {
    installDesktopBridge({ prepareCanvasPrototypeSurface: async () => ({ status: "ready" }) });
    const run = runRuntime({ contained: true, drawnIn: "desktop-surface", runsOnOpen: true });
    render(
      <StrictMode>
        <CanvasDocument
          definition={{ ...canvasFixture, blocks: [prototype()] }}
          designRunRuntime={run.runtime}
        />
      </StrictMode>,
    );
    await screen.findByTitle("Checkout, running prototype");
    await act(async () => {
      await Promise.resolve();
    });
    expect(prototypeHost.opened).toHaveLength(1);
    expect(prototypeHost.closed).toEqual([]);
  });

  it("forwards clicks in the page's own pixels, however the prototype is scaled", async () => {
    runDesktop({ runsOnOpen: true });
    const view = await screen.findByTitle("Checkout, running prototype");
    // Drawn at half size, 20 pixels in from the window's corner.
    view.getBoundingClientRect = () =>
      DOMRect.fromRect({
        x: 20,
        y: 20,
        width: CANVAS_DESIGN_VIEWPORT.phone.width / 2,
        height: CANVAS_DESIGN_VIEWPORT.phone.height / 2,
      });
    fireEvent.mouseDown(view, { clientX: 150, clientY: 350, button: 0, detail: 1 });
    expect(prototypeHost.inputs).toEqual([
      { type: "mouseDown", x: 260, y: 660, button: "left", clickCount: 1, modifiers: [] },
    ]);
  });

  it("types into the page, and hands focus to Stop on the reserved shortcut without the page seeing it", async () => {
    runDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const view = await screen.findByTitle("Checkout, running prototype");
    (view as HTMLElement).focus();
    expect(document.activeElement).toBe(view);
    prototypeHost.inputs.length = 0;
    fireEvent.keyDown(view, { key: "a" });
    fireEvent.keyDown(view, { key: "ArrowLeft" });
    expect(prototypeHost.inputs).toEqual([
      { type: "keyDown", keyCode: "a", modifiers: [] },
      { type: "char", keyCode: "a", modifiers: [] },
      { type: "keyDown", keyCode: "Left", modifiers: [] },
    ]);
    prototypeHost.inputs.length = 0;
    // jsdom reports no Mac, so the reserved shortcut is Control-Escape.
    fireEvent.keyDown(view, { key: "Escape", ctrlKey: true });
    expect(prototypeHost.inputs.filter((input) => input.type !== "blur")).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop" }));
  });
});

describe("where a running prototype is drawn", () => {
  const client = () => {
    const runDesign = vi.fn(async () => ({ kind: "ready" as const, url: PAGE }));
    return {
      runDesign,
      runtime: designRunRuntimeFor(
        { runDesign },
        {
          canvasId: decodeCanvasId("22222222-2222-4222-8222-222222222222"),
          versionId: "33333333-3333-4333-8333-333333333333",
          runsOnOpen: false,
        },
      ),
    };
  };

  function runFromThread(runtime: DesignRunRuntime) {
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
        placement="thread"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
  }

  it("draws on the desktop's own surface only in the desktop app, and in a frame in a browser", () => {
    installDesktopBridge();
    expect(client().runtime).toMatchObject({ contained: true, drawnIn: "desktop-surface" });
    delete (window as { octantHost?: unknown }).octantHost;
    expect(client().runtime).toMatchObject({ contained: false, drawnIn: "frame" });
  });

  it("draws the preview browser's prototype in a frame, because that browser has no route out and no desktop surface", async () => {
    // The preview page says it is contained and draws a frame: there is no
    // prototype host in the preview browser to draw it from.
    const prepare = vi.fn(async () => ({ status: "ready" as const }));
    installDesktopBridge({ prepareCanvasPrototypeSurface: prepare });
    const { start, runtime } = runRuntime({ contained: true, drawnIn: "frame", runsOnOpen: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    const frame = await screen.findByTitle<HTMLIFrameElement>("Checkout, running prototype");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(PAGE);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(views(document)).toHaveLength(0);
    expect(start).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(screen.queryByText(/not network-contained/)).toBeNull();
    expect(screen.queryByText(/look up host names/)).toBeNull();
    expect(screen.getByText(/no network connection/)).toBeVisible();
  });

  it("closes the desktop surface's network before it asks any runtime for a page", async () => {
    const order: Array<string> = [];
    installDesktopBridge({
      prepareCanvasPrototypeSurface: async () => {
        order.push("surface");
        return { status: "ready" };
      },
    });
    const { runDesign, runtime } = client();
    runDesign.mockImplementation(async () => {
      order.push("ticket");
      return { kind: "ready" as const, url: PAGE };
    });
    runFromThread(runtime!);
    await screen.findByTitle("Checkout, running prototype");
    expect(prototypeHost.opened.map((request) => request.src)).toEqual([PAGE]);
    expect(order).toEqual(["surface", "ticket"]);
  });

  it("does not run a prototype drawn on the surface, and never asks for a page, when the surface cannot be made", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "Octant could not close the prototype surface's network, so it does not run.",
        {
          prepareCanvasPrototypeSurface: async () => ({
            status: "unavailable",
            reason: "Octant could not close the prototype surface's network, so it does not run.",
          }),
        },
      ],
      [
        "Octant could not start the prototype surface, so it does not run.",
        {
          prepareCanvasPrototypeSurface: async () => {
            throw new Error("ipc failed");
          },
        },
      ],
      ["This version of Octant cannot contain a prototype, so it does not run.", {}],
    ];
    for (const [reason, bridgeFields] of cases) {
      cleanup();
      installDesktopBridge(bridgeFields);
      const { runDesign, runtime } = client();
      runFromThread(runtime!);
      expect(await screen.findByText(reason)).toBeVisible();
      expect(runDesign).not.toHaveBeenCalled();
      expect(frames(document)).toHaveLength(0);
      expect(views(document)).toHaveLength(0);
    }
  });

  it("prepares for a runtime built anywhere else that says it draws on the surface", async () => {
    // A shared snapshot builds its own runtime; the block, not each builder,
    // is what makes sure the surface exists first.
    const prepare = vi.fn(async () => ({
      status: "unavailable" as const,
      reason: "Closed for repairs.",
    }));
    installDesktopBridge({ prepareCanvasPrototypeSurface: prepare });
    const { start, runtime } = runRuntime({ contained: true, drawnIn: "desktop-surface" });
    runFromThread(runtime);
    expect(await screen.findByText("Closed for repairs.")).toBeVisible();
    expect(prepare).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it("runs in a frame, with no surface to prepare, where there is no desktop app", async () => {
    const { runDesign, runtime } = client();
    runFromThread(runtime!);
    const frame = await screen.findByTitle<HTMLIFrameElement>("Checkout, running prototype");
    expect(frame.tagName).toBe("IFRAME");
    expect(runDesign).toHaveBeenCalledOnce();
    expect(screen.getByText(/can still connect to another computer/)).toBeVisible();
  });
});

describe("design bridge messages", () => {
  it("accepts only typed, bounded messages from the frame's own window", () => {
    const frame = {} as Window;
    const other = {} as Window;
    const message = (data: unknown, source: Window = frame, origin = "null") =>
      readDesignBridgeMessage({ data, source, origin }, frame);
    const channel = "octant-design-frame@1";
    expect(message({ channel, type: "heartbeat" })).toEqual({ type: "heartbeat" });
    expect(message({ channel, type: "size", height: 12.2 })).toEqual({ type: "size", height: 48 });
    expect(message({ channel, type: "size", height: 400.2 })).toEqual({
      type: "size",
      height: 401,
    });
    expect(message({ channel, type: "error", message: "  " })).toEqual({
      type: "error",
      message: "Script error",
    });
    for (const rejected of [
      message({ channel, type: "heartbeat" }, other),
      message({ channel, type: "heartbeat" }, frame, "http://127.0.0.1:3773"),
      message({ channel: "other", type: "heartbeat" }),
      message({ channel, type: "navigate", url: "https://example.test" }),
      message({ channel, type: "size", height: Number.NaN }),
      message({ channel, type: "size", height: Number.POSITIVE_INFINITY }),
      message({ channel, type: "error", message: 3 }),
      message("heartbeat"),
      message([channel, "heartbeat"]),
      message(null),
      readDesignBridgeMessage(
        { data: { channel, type: "heartbeat" }, source: frame, origin: "null" },
        null,
      ),
    ]) {
      expect(rejected).toBeUndefined();
    }
  });
});
