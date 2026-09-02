import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDesktopWindowAuthority } from "./useDesktopWindowAuthority";

describe("useDesktopWindowAuthority", () => {
  it("replaces the static preload capability when the host reissues window authority", () => {
    let publish: ((capability: string) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      subscribeProjectWindowCapability: vi.fn((listener: (capability: string) => void) => {
        publish = listener;
        return unsubscribe;
      }),
    };
    const initial = "A".repeat(43);
    const replacement = "B".repeat(43);
    const { result, unmount } = renderHook(() => useDesktopWindowAuthority(initial, bridge));

    expect(result.current).toBe(initial);
    act(() => publish?.(replacement));
    expect(result.current).toBe(replacement);

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
