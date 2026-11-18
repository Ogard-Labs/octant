import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_SURFACE_RESIZE_GUARD_PX,
  rectClearOfResizeGuard,
  setNativeSurfaceResizeGuard,
  signalNativeSurfaceLayoutChange,
  useNativeBrowserSurface,
} from "./useNativeBrowserSurface";
import type { OctantHostBridge } from "../shell/hostBridge";

class NoopObserver {
  observe(): void {}
  disconnect(): void {}
}

function Surface(props: { readonly bridge: OctantHostBridge }) {
  const surface = useNativeBrowserSurface({
    contextId: "60000000-0000-4000-8000-000000000001",
    enabled: true,
    hostBridge: props.bridge,
    overlaySelector: "[data-overlay]",
    threadId: "10000000-0000-4000-8000-000000000001",
  });
  return <div ref={surface.mount} />;
}

describe("a native browser surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function setup() {
    vi.stubGlobal("ResizeObserver", NoopObserver);
    vi.stubGlobal("IntersectionObserver", NoopObserver);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
      length: 1,
    } as unknown as DOMRectList);
    let left = 100;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() =>
      DOMRect.fromRect({ x: left, y: 200, width: 300, height: 400 }),
    );
    const update = vi.fn(async () => undefined);
    const bridge = {
      attachBrowserSurface: vi.fn(async () => ({})),
      updateBrowserSurfaceBounds: update,
      detachBrowserSurface: vi.fn(async () => undefined),
    } as unknown as OctantHostBridge;
    return { bridge, update, moveTo: (next: number) => (left = next) };
  }

  const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

  it("reads its bounds again when the layout around it moves it without resizing it", async () => {
    const { bridge, update, moveTo } = setup();
    render(<Surface bridge={bridge} />);
    await waitFor(() => expect(bridge.attachBrowserSurface).toHaveBeenCalled());

    moveTo(500);
    signalNativeSurfaceLayoutChange();
    signalNativeSurfaceLayoutChange();
    await frame();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ bounds: { x: 500, y: 200, width: 300, height: 400 } }),
    );
  });

  it("does not call the host when the signal finds it where it already was", async () => {
    const { bridge, update } = setup();
    render(<Surface bridge={bridge} />);
    await waitFor(() => expect(bridge.attachBrowserSurface).toHaveBeenCalled());

    signalNativeSurfaceLayoutChange();
    await frame();

    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the page clear of a held divider and shows it at the final bounds when the divider is let go", async () => {
    const { bridge, update, moveTo } = setup();
    render(<Surface bridge={bridge} />);
    await waitFor(() => expect(bridge.attachBrowserSurface).toHaveBeenCalled());

    // The tile's left edge is at 100 and its pointer is dragging the divider there.
    setNativeSurfaceResizeGuard({ axis: "x", at: 90 });
    await frame();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bounds: { x: 90 + NATIVE_SURFACE_RESIZE_GUARD_PX, y: 200, width: 270, height: 400 },
      }),
    );
    expect(bridge.detachBrowserSurface).not.toHaveBeenCalled();

    moveTo(160);
    setNativeSurfaceResizeGuard(undefined);
    await frame();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ bounds: { x: 160, y: 200, width: 300, height: 400 } }),
    );
    expect(bridge.detachBrowserSurface).not.toHaveBeenCalled();
  });

  it("attaches again only after a slow detach has finished when an overlay comes and goes", async () => {
    const { bridge } = setup();
    const order: string[] = [];
    let finishDetach: () => void = () => {};
    vi.mocked(bridge.attachBrowserSurface as () => Promise<unknown>).mockImplementation(
      async () => {
        order.push("attach");
        return {};
      },
    );
    vi.mocked(bridge.detachBrowserSurface as () => Promise<void>).mockImplementation(async () => {
      order.push("detach:start");
      await new Promise<void>((done) => {
        finishDetach = done;
      });
      order.push("detach:end");
    });
    render(<Surface bridge={bridge} />);
    await waitFor(() => expect(order).toEqual(["attach"]));

    const overlay = document.createElement("div");
    overlay.setAttribute("data-overlay", "");
    document.body.append(overlay);
    await waitFor(() => expect(order).toEqual(["attach", "detach:start"]));
    overlay.remove();
    // The overlay is already gone while the host is still taking the page out.
    await frame();
    expect(order).toEqual(["attach", "detach:start"]);

    finishDetach();
    await waitFor(() => expect(order).toEqual(["attach", "detach:start", "detach:end", "attach"]));
  });
});

describe("keeping a native page clear of a held divider", () => {
  const rect = { left: 100, top: 200, right: 400, bottom: 600 };

  it("pulls the near edge back on the side of the pointer the page is on", () => {
    expect(rectClearOfResizeGuard(rect, { axis: "x", at: 90 })).toEqual({
      ...rect,
      left: 90 + NATIVE_SURFACE_RESIZE_GUARD_PX,
    });
    expect(rectClearOfResizeGuard(rect, { axis: "x", at: 420 })).toEqual({
      ...rect,
      right: 420 - NATIVE_SURFACE_RESIZE_GUARD_PX,
    });
    expect(rectClearOfResizeGuard(rect, { axis: "y", at: 190 })).toEqual({
      ...rect,
      top: 190 + NATIVE_SURFACE_RESIZE_GUARD_PX,
    });
  });

  it("leaves a page that is already clear, or a drag that is over, as it was", () => {
    expect(rectClearOfResizeGuard(rect, { axis: "x", at: 20 })).toEqual(rect);
    expect(rectClearOfResizeGuard(rect, undefined)).toBe(rect);
  });
});
