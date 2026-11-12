import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
});
