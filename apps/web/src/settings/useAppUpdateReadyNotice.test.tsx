import { decodeAppVersion, type AppUpdateState } from "@octant/contracts/app-updates";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import { useAppUpdateReadyNotice } from "./useAppUpdateReadyNotice";

describe("useAppUpdateReadyNotice", () => {
  it("shows a dismissed notice again only for a new downloaded update", () => {
    let listener: ((state: AppUpdateState) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe: NonNullable<OctantHostBridge["subscribeAppUpdateState"]> = (callback) => {
      listener = callback;
      return unsubscribe;
    };
    const { result, unmount } = renderHook(() => useAppUpdateReadyNotice(subscribe));
    const publish = listener;
    expect(publish).toBeDefined();
    if (publish === undefined) return;
    const state: AppUpdateState = {
      status: "downloading",
      currentVersion: decodeAppVersion("1.0.0"),
      automaticChecks: false,
      ring: "stable",
    };

    act(() => publish(state));
    expect(result.current[0]).toBe(false);
    act(() => publish({ ...state, status: "ready" }));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1]());
    act(() => publish({ ...state, status: "ready" }));
    expect(result.current[0]).toBe(false);
    act(() => publish(state));
    act(() => publish({ ...state, status: "ready" }));
    expect(result.current[0]).toBe(true);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
