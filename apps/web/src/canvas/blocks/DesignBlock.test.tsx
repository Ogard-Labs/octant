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

function runRuntime(fields: Partial<DesignRunRuntime> = {}) {
  const start = vi.fn<DesignRunRuntime["start"]>(async () => ({ kind: "ready", url: PAGE }));
  return { start, runtime: { start, contained: false, runsOnOpen: false, ...fields } };
}

/** What the desktop's surface for a prototype reports for its page, as the element delivers it. */
function surfaceBridge(view: Element, data: Record<string, unknown>, channel?: string) {
  const event = Object.assign(new Event("ipc-message"), {
    channel: channel ?? "octant-canvas-prototype-bridge",
    args: [{ channel: "octant-design-frame@1", ...data }],
  });
  view.dispatchEvent(event);
}

function views(container: ParentNode): ReadonlyArray<Element> {
  return Array.from(container.querySelectorAll("webview"));
}

function installDesktopBridge(fields: Record<string, unknown> = {}) {
  (window as { octantHost?: unknown }).octantHost = {
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

afterEach(() => {
  vi.useRealTimers();
  delete (window as { octantHost?: unknown }).octantHost;
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
    // Pressed by the person, so the frame may take focus.
    expect(frame).not.toHaveAttribute("tabindex");
    expect(within(region).getByRole("status")).toHaveTextContent("Running");
    expect(within(region).queryByText(/not network-contained/)).toBeNull();

    fireEvent.click(within(region).getByRole("button", { name: "Stop" }));
    expect(frames(region)).toHaveLength(0);
    expect(within(region).getByRole("button", { name: "Run again" })).toBeVisible();
  });

  it("runs on open in the sidebar without taking focus, and in the desktop app says it has no network and what still leaves", async () => {
    const { start, runtime } = runRuntime({ runsOnOpen: true, contained: true });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype()] }}
        designRunRuntime={runtime}
      />,
    );
    const view = await screen.findByTitle("Checkout, running prototype");
    expect(start).toHaveBeenCalledOnce();
    expect(view.tagName).toBe("WEBVIEW");
    expect(view).toHaveAttribute("tabindex", "-1");
    // The desktop draws it in a surface of its own, never in a frame.
    expect(frames(document)).toHaveLength(0);
    expect(screen.queryByText(/not network-contained/)).toBeNull();
    expect(screen.queryByText(/can still connect to another computer/)).toBeNull();
    expect(screen.getByText(/no network connection/)).toBeVisible();
    expect(screen.getByText(/look up host names/)).toBeVisible();
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
    const run = runRuntime({ contained: true, ...fields });
    render(
      <CanvasDocument
        definition={{ ...canvasFixture, blocks: [prototype(size)] }}
        designRunRuntime={run.runtime}
      />,
    );
    return run;
  }

  it("draws the page in a surface of its own with the host's ticketed address and nothing else", async () => {
    runDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const view = await screen.findByTitle("Checkout, running prototype");
    expect(view.tagName).toBe("WEBVIEW");
    expect(view).toHaveAttribute("src", PAGE);
    // The renderer names no partition, preload, or preference of its own.
    for (const attribute of ["partition", "preload", "webpreferences", "allowpopups"]) {
      expect(view).not.toHaveAttribute(attribute);
    }
    expect(view).not.toHaveAttribute("sandbox");
    expect(frames(document)).toHaveLength(0);
    // Pressed by the person, so the surface may take focus.
    expect(view).toHaveAttribute("tabindex", "0");
  });

  it("keeps a prototype running while its page beats, stops it when the beats stop, and offers to run it again", async () => {
    vi.useFakeTimers();
    runDesktop({ runsOnOpen: true });
    await act(async () => {
      await Promise.resolve();
    });
    const view = screen.getByTitle("Checkout, running prototype");
    for (let second = 0; second < 12; second += 1) {
      act(() => {
        surfaceBridge(view, { type: "heartbeat" });
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(views(document)).toHaveLength(1);

    // Beats on any other channel keep nothing alive.
    for (let second = 0; second <= RUNNING_DESIGN_HEARTBEAT_TIMEOUT_MS / 1_000 + 1; second += 1) {
      act(() => {
        surfaceBridge(view, { type: "heartbeat" }, "other-channel");
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
    act(() => surfaceBridge(view, { type: "size", height: 640 }));
    expect((view as HTMLElement).style.height).toBe("640px");
    act(() => surfaceBridge(view, { type: "size", height: 10_000_000 }));
    expect((view as HTMLElement).style.height).toBe("12000px");
    act(() => surfaceBridge(view, { type: "size", height: "300" }));
    act(() => surfaceBridge(view, { channel: "other", type: "size", height: 300 }));
    act(() => surfaceBridge(view, { type: "navigate", url: "https://example.test" }));
    act(() => surfaceBridge(view, { type: "size", height: 300 }, "other-channel"));
    expect((view as HTMLElement).style.height).toBe("12000px");

    act(() => surfaceBridge(view, { type: "error", message: `<b>boom</b>${"x".repeat(1_000)}` }));
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
    const view = screen.getByTitle("Checkout, running prototype");
    act(() => {
      for (let sent = 0; sent <= RUNNING_DESIGN_MAX_MESSAGES_PER_SECOND; sent += 1) {
        surfaceBridge(view, { type: "error", message: `boom ${String(sent)}` });
      }
    });
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/sent too many messages/)).toBeVisible();
  });

  it("removes a prototype that loads a second page or whose surface goes away", async () => {
    runDesktop({ runsOnOpen: true });
    const view = await screen.findByTitle("Checkout, running prototype");
    fireEvent(view, new Event("did-navigate"));
    expect(views(document)).toHaveLength(1);
    fireEvent(view, new Event("did-navigate"));
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/tried to load another page/)).toBeVisible();
    cleanup();

    runDesktop({ runsOnOpen: true });
    const crashed = await screen.findByTitle("Checkout, running prototype");
    fireEvent(crashed, new Event("render-process-gone"));
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/stopped responding/)).toBeVisible();
  });

  it("hands focus to Stop when the desktop's reserved shortcut fires while the prototype holds it", async () => {
    let escape: (() => void) | undefined;
    installDesktopBridge({
      subscribeCanvasFrameFocusEscape: (listener: () => void) => {
        escape = listener;
        return () => {
          escape = undefined;
        };
      },
    });
    runDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const view = await screen.findByTitle("Checkout, running prototype");
    (view as HTMLElement).focus();
    expect(document.activeElement).toBe(view);
    act(() => escape?.());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop" }));
  });

  it("stops a prototype that takes the keyboard straight back after the reserved shortcut", async () => {
    let escape: (() => void) | undefined;
    installDesktopBridge({
      subscribeCanvasFrameFocusEscape: (listener: () => void) => {
        escape = listener;
        return () => undefined;
      },
    });
    runDesktop();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const view = await screen.findByTitle("Checkout, running prototype");
    vi.useFakeTimers();
    (view as HTMLElement).focus();
    act(() => escape?.());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stop" }));
    // The page refocuses itself, as one listening for blur can.
    (view as HTMLElement).focus();
    act(() => vi.advanceTimersByTime(200));
    expect(views(document)).toHaveLength(0);
    expect(screen.getByText(/kept taking the keyboard back/)).toBeVisible();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Run again" }));
  });
});

describe("running a prototype in the desktop app needs its contained surface", () => {
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

  it("asks the host for a ticket only after the desktop has closed the surface's network", async () => {
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
    expect(runtime?.contained).toBe(true);
    await expect(runtime?.start("checkout")).resolves.toEqual({ kind: "ready", url: PAGE });
    expect(order).toEqual(["surface", "ticket"]);
  });

  it("does not run, and never asks for a ticket, when the surface cannot be made", async () => {
    installDesktopBridge({
      prepareCanvasPrototypeSurface: async () => ({
        status: "unavailable",
        reason: "Octant could not close the prototype surface's network, so it does not run.",
      }),
    });
    const refused = client();
    await expect(refused.runtime?.start("checkout")).resolves.toEqual({
      kind: "refused",
      reason: "Octant could not close the prototype surface's network, so it does not run.",
    });
    expect(refused.runDesign).not.toHaveBeenCalled();

    installDesktopBridge({
      prepareCanvasPrototypeSurface: async () => {
        throw new Error("ipc failed");
      },
    });
    const failed = client();
    await expect(failed.runtime?.start("checkout")).resolves.toMatchObject({ kind: "refused" });
    expect(failed.runDesign).not.toHaveBeenCalled();

    // A desktop that predates the surface cannot hold a prototype either.
    installDesktopBridge();
    const old = client();
    await expect(old.runtime?.start("checkout")).resolves.toMatchObject({ kind: "refused" });
    expect(old.runDesign).not.toHaveBeenCalled();
  });

  it("runs in a frame, with no surface to prepare, where there is no desktop app", async () => {
    const { runDesign, runtime } = client();
    expect(runtime?.contained).toBe(false);
    await expect(runtime?.start("checkout")).resolves.toEqual({ kind: "ready", url: PAGE });
    expect(runDesign).toHaveBeenCalledOnce();
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
