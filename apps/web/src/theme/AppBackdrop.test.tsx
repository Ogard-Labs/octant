import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppBackdrop } from "./AppBackdrop";

afterEach(cleanup);

const dials = {
  effect: { kind: "dither", cell: 2, levels: 4 },
  photoOpacity: 0.42,
  scope: "welcome",
  coversSidebar: false,
  backgroundUrl: null,
  backgroundStillUrl: null,
  backgroundAnimated: false,
} as const;

describe("AppBackdrop", () => {
  beforeEach(() => {
    // jsdom has no canvas: the photo degrades to its fetch and may not throw.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws nothing when the ground is off", () => {
    const { container } = render(
      <AppBackdrop
        fetcher={vi.fn()}
        placement="welcome"
        resolved={{ ...dials, kind: "none", backgroundId: null }}
      />,
    );
    expect(container.querySelector("[data-octant-app-backdrop]")).toBeNull();
  });

  it("asks the authenticated fetcher for the photo the ground names", async () => {
    const fetcher = vi.fn(
      async () => new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }),
    );
    const { container } = render(
      <AppBackdrop
        fetcher={fetcher}
        placement="welcome"
        resolved={{ ...dials, kind: "photo", backgroundId: "00000000-0000-4000-8000-000000000b01" }}
      />,
    );
    const ground = container.querySelector("[data-octant-app-backdrop]");
    expect(ground).toHaveAttribute("data-octant-app-backdrop", "photo");
    expect(ground).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".app-backdrop__photo")).not.toBeNull();
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000b01");
    });
  });

  it("renders a built-in background without asking the photo library", () => {
    const fetcher = vi.fn();
    const { container } = render(
      <AppBackdrop
        fetcher={fetcher}
        placement="shell"
        resolved={{
          ...dials,
          kind: "builtin",
          backgroundId: "perspective-dot-plane-animated",
          backgroundUrl: "/zen-backgrounds/perspective-dot-plane-dark.webp",
          backgroundStillUrl: "/zen-backgrounds/perspective-dot-plane.jpg",
          backgroundAnimated: true,
          // Plain, so the animated preset stays a moving CSS image.
          effect: { kind: "none", cell: 3, levels: 8 },
        }}
      />,
    );
    const ground = container.querySelector("[data-octant-app-backdrop]");
    expect(ground).toHaveAttribute("data-octant-app-backdrop", "builtin");
    expect(container.querySelector(".app-backdrop__builtin")).toHaveStyle({
      backgroundImage: 'url("/zen-backgrounds/perspective-dot-plane-dark.webp")',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("prints a built-in through its effect from the still frame, with no pattern over it", async () => {
    const fetched = vi.fn(async () => new Response(new Blob([new Uint8Array([1])])));
    vi.stubGlobal("fetch", fetched);
    try {
      const { container } = render(
        <AppBackdrop
          fetcher={vi.fn()}
          placement="shell"
          resolved={{
            ...dials,
            kind: "builtin",
            backgroundId: "perspective-dot-plane-animated",
            backgroundUrl: "/zen-backgrounds/perspective-dot-plane-dark.webp",
            backgroundStillUrl: "/zen-backgrounds/perspective-dot-plane.jpg",
            backgroundAnimated: true,
            effect: { kind: "pixelate", cell: 6, levels: 8 },
          }}
        />,
      );
      expect(container.querySelector(".app-backdrop__builtin")).toBeNull();
      expect(container.querySelector(".app-backdrop__photo")).toHaveAttribute(
        "data-effect",
        "pixelate",
      );
      expect(container.querySelector(".app-backdrop__pattern")).toBeNull();
      await waitFor(() =>
        expect(fetched).toHaveBeenCalledWith("/zen-backgrounds/perspective-dot-plane.jpg"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("marks a photo as clean when it has no effect", () => {
    const { container } = render(
      <AppBackdrop
        fetcher={vi.fn(async () => new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" }))}
        placement="welcome"
        resolved={{
          ...dials,
          kind: "photo",
          backgroundId: "00000000-0000-4000-8000-000000000b01",
          effect: { kind: "none", cell: 2, levels: 4 },
        }}
      />,
    );
    expect(container.querySelector(".app-backdrop__photo")).toHaveAttribute(
      "data-dithered",
      "false",
    );
  });
});
