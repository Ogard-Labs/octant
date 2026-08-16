import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SidebarBackgroundLayer } from "./SidebarBackgroundLayer";

afterEach(cleanup);

describe("SidebarBackgroundLayer", () => {
  it("renders nothing for kind none", () => {
    const { container } = render(
      <SidebarBackgroundLayer
        resolved={{
          kind: "none",
          backgroundCss: null,
          backgroundId: null,
          overlayColor: "#1a1a1c",
          overlayOpacity: 100,
          vibrancyMode: "off",
        }}
        fetcher={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-octant-sidebar-background]")).toBeNull();
  });

  it("renders a preset background layer with css and scrim", () => {
    const { container } = render(
      <SidebarBackgroundLayer
        resolved={{
          kind: "preset",
          backgroundCss: "linear-gradient(135deg, #1a1a1c, #2a2a2e)",
          backgroundId: null,
          overlayColor: "#000000",
          overlayOpacity: 60,
          vibrancyMode: "off",
        }}
        fetcher={vi.fn()}
      />,
    );
    const bg = container.querySelector("[data-octant-sidebar-background]");
    expect(bg).not.toBeNull();
    expect(bg?.getAttribute("style") ?? "").toContain("linear-gradient");
    const scrim = container.querySelector("[data-octant-sidebar-overlay]");
    expect(scrim).not.toBeNull();
    expect(scrim?.getAttribute("style") ?? "").toContain("opacity: 0.6");
  });

  it("fetches custom background via authenticated fetcher and renders a blob url", async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" });
    const fetcher = vi.fn(async (id: string) => blob);
    const { container } = render(
      <SidebarBackgroundLayer
        resolved={{
          kind: "custom",
          backgroundCss: null,
          backgroundId: "00000000-0000-4000-8000-000000000b01",
          overlayColor: "#1a1a1c",
          overlayOpacity: 40,
          vibrancyMode: "subtle",
        }}
        fetcher={fetcher}
      />,
    );
    await waitFor(() => {
      const bg = container.querySelector("[data-octant-sidebar-background]");
      expect(bg).not.toBeNull();
      expect(bg?.getAttribute("style") ?? "").toMatch(/url\(["']?blob:.+\)/);
    });
    expect(fetcher).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000b01");
  });
});
