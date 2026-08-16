import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useFirstRunOnboardingController,
  type UseFirstRunOnboardingControllerOptions,
} from "./useFirstRunOnboardingController";

function render(overrides: Partial<UseFirstRunOnboardingControllerOptions> = {}) {
  const resolve = vi.fn(async () => {});
  const options: UseFirstRunOnboardingControllerOptions = {
    onboarding: "pending",
    shellStatus: "ready",
    resolve,
    ...overrides,
  };
  return {
    resolve,
    ...renderHook((props) => useFirstRunOnboardingController(props), {
      initialProps: options,
    }),
  };
}

describe("useFirstRunOnboardingController", () => {
  it("shows first run only while the host still reports it as pending", () => {
    expect(render().result.current.visible).toBe(true);
    expect(render({ onboarding: "completed" }).result.current.visible).toBe(false);
    expect(render({ onboarding: "skipped" }).result.current.visible).toBe(false);
    // Nothing authoritative has arrived yet, so the surface must not flash.
    expect(render({ shellStatus: "loading" }).result.current.visible).toBe(false);
    expect(render({ onboarding: undefined }).result.current.visible).toBe(false);
  });

  it("stands the surface down for this session without answering for the user", () => {
    const { result, resolve } = render();

    act(() => result.current.defer());

    expect(result.current.visible).toBe(false);
    // Nothing durable was recorded, so the host still reports first run as
    // pending and a user who backs out of Settings meets it again next launch.
    expect(resolve).not.toHaveBeenCalled();
    expect(render().result.current.visible).toBe(true);
  });

  it("records the chosen outcome on the host and reports the in-flight answer", async () => {
    let release = () => {};
    const resolve = vi.fn(
      async () =>
        await new Promise<void>((resolveGate) => {
          release = resolveGate;
        }),
    );
    const { result } = render({ resolve });

    act(() => result.current.complete());
    expect(resolve).toHaveBeenCalledWith("completed");
    expect(result.current.submitting).toBe("completed");

    await act(async () => {
      release();
    });
    expect(result.current.submitting).toBeUndefined();

    act(() => result.current.skip());
    expect(resolve).toHaveBeenLastCalledWith("skipped");
  });

  it("discards a superseded answer instead of clearing the newer one", async () => {
    const gates: Array<() => void> = [];
    const resolve = vi.fn(
      async () =>
        await new Promise<void>((resolveGate) => {
          gates.push(resolveGate);
        }),
    );
    const { result } = render({ resolve });

    act(() => result.current.skip());
    act(() => result.current.complete());
    expect(result.current.submitting).toBe("completed");

    // The first, superseded answer settling must not report the second one done.
    await act(async () => {
      gates[0]?.();
    });
    expect(result.current.submitting).toBe("completed");

    await act(async () => {
      gates[1]?.();
    });
    await waitFor(() => expect(result.current.submitting).toBeUndefined());
  });

  it("refuses to answer and explains why when the host cannot record it", () => {
    const { result, resolve } = render({ shellStatus: "disconnected" });

    act(() => result.current.complete());

    expect(resolve).not.toHaveBeenCalled();
    expect(result.current.submitting).toBeUndefined();
    expect(result.current.blockedMessage).toContain("cannot reach the host");
    expect(render().result.current.blockedMessage).toBeUndefined();
  });
});
