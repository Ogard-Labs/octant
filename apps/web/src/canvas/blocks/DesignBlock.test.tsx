import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { decodeCanvasBlock, type CanvasDesignBlock } from "@octant/contracts/canvas";
import {
  launchDeckExampleBlock,
  onboardingFlowExampleBlock,
  searchSpecExampleBlock,
} from "@octant/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";
import { designAssetPlaceholder, type DesignAssetRuntime } from "./designDocument";

function frames(container: ParentNode): ReadonlyArray<HTMLIFrameElement> {
  return Array.from(container.querySelectorAll("iframe"));
}

function design(fields: Partial<Pick<CanvasDesignBlock, "size" | "theme">>): CanvasDesignBlock {
  const block = decodeCanvasBlock({ ...onboardingFlowExampleBlock, ...fields });
  if (block.kind !== "design") throw new Error("Fixture is not a design.");
  return block;
}

afterEach(() => {
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
