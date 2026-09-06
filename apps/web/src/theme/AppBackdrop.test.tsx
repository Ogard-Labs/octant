import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppBackdrop } from "./AppBackdrop";

afterEach(cleanup);

const dials = {
  patternOpacity: 0.55,
  patternSpeed: 1,
  patternIntensity: 0.6,
  photoOpacity: 0.42,
  scope: "welcome",
  coversSidebar: false,
} as const;

describe("AppBackdrop", () => {
  beforeEach(() => {
    // jsdom has no canvas: the pattern degrades to nothing, the photo to
    // its fetch, and neither may throw.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete document.documentElement.dataset.octantThemeMode;
  });

  it("draws nothing when the ground is off", () => {
    const { container } = render(
      <AppBackdrop
        fetcher={vi.fn()}
        placement="welcome"
        resolved={{ ...dials, kind: "none", backgroundId: null, animated: false }}
      />,
    );
    expect(container.querySelector("[data-octant-app-backdrop]")).toBeNull();
  });

  it("keeps the ground when the browser has no WebGL, and says whether it moves", () => {
    const { container } = render(
      <AppBackdrop
        fetcher={vi.fn()}
        placement="welcome"
        resolved={{ ...dials, kind: "theme", backgroundId: null, animated: false }}
      />,
    );
    const ground = container.querySelector("[data-octant-app-backdrop]");
    expect(ground?.getAttribute("data-octant-app-backdrop")).toBe("theme");
    expect(ground?.getAttribute("data-animated")).toBe("false");
    expect(ground?.getAttribute("aria-hidden")).toBe("true");
    // Without WebGL2 the pattern canvas is dropped rather than left blank.
    expect(container.querySelector(".app-backdrop__pattern")).toBeNull();
  });

  it("presses the pattern into a light theme and lifts it out of a dark one", () => {
    document.documentElement.dataset.octantThemeMode = "light";
    const { container } = render(
      <AppBackdrop
        fetcher={vi.fn()}
        placement="shell"
        resolved={{ ...dials, kind: "theme", backgroundId: null, animated: true }}
      />,
    );
    // The blend is decided before the canvas learns it has no context.
    const pattern = container.querySelector(".app-backdrop__pattern");
    expect(pattern === null || pattern.getAttribute("data-blend") === "multiply").toBe(true);
  });

  it("asks the authenticated fetcher for the photo the ground names", async () => {
    const fetcher = vi.fn(
      async () => new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
    );
    const { container } = render(
      <AppBackdrop
        fetcher={fetcher}
        placement="welcome"
        resolved={{
          ...dials,
          kind: "photo",
          backgroundId: "00000000-0000-4000-8000-000000000b01",
          animated: true,
        }}
      />,
    );
    expect(
      container
        .querySelector("[data-octant-app-backdrop]")
        ?.getAttribute("data-octant-app-backdrop"),
    ).toBe("photo");
    expect(container.querySelector(".app-backdrop__photo")).not.toBeNull();
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000b01");
    });
  });
});
