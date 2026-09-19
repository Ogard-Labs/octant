import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AppleScreenStreamRequest } from "@octant/contracts/apple-toolchain-rpc";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppleSimulatorLiveScreen } from "./useAppleSimulatorLiveScreen";

const request = {
  kind: "apple-screen-stream-request",
  simulatorId: "7E29846E-F920-438E-8AB2-930C1A0F7FB7",
} as unknown as AppleScreenStreamRequest;
const decode = vi.fn(async () => ({ width: 506, height: 1_100, close: vi.fn() }));

/** A stream the test feeds by hand and can end. */
function feed() {
  let push!: (frame: Uint8Array) => void;
  let end!: () => void;
  const queue: Array<Uint8Array | undefined> = [];
  let wake: (() => void) | undefined;
  push = (frame) => {
    queue.push(frame);
    wake?.();
  };
  end = () => {
    queue.push(undefined);
    wake?.();
  };
  async function* frames() {
    for (;;) {
      while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      const next = queue.shift();
      if (next === undefined) return;
      yield next;
    }
  }
  return { push, end, frames: frames() };
}

function clientWatching(watchScreen: AppleToolchainClient["watchScreen"]): AppleToolchainClient {
  return { watchScreen } as unknown as AppleToolchainClient;
}

afterEach(() => {
  vi.useRealTimers();
  decode.mockClear();
});

describe("the live Simulator screen", () => {
  it("is off until asked for, then goes live on the first painted frame with the device's size", async () => {
    const stream = feed();
    const watchScreen = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
      status: "watching" as const,
      screen: { width: 1206, height: 2622 },
      frames: stream.frames,
    }));
    const client = clientWatching(watchScreen);
    const { result, rerender } = renderHook(
      ({ enabled }) => useAppleSimulatorLiveScreen({ client, request, enabled, decode }),
      { initialProps: { enabled: false } },
    );
    expect(result.current.status).toBe("off");
    expect(watchScreen).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("connecting"));
    stream.push(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));

    await waitFor(() => expect(result.current.status).toBe("live"));
    if (result.current.status !== "live") return;
    expect(result.current.screen).toEqual({ width: 1206, height: 2622 });
    const canvas = document.createElement("canvas");
    result.current.attach(canvas);
    // A canvas attached after a frame arrived shows that frame at its size.
    expect([canvas.width, canvas.height]).toEqual([506, 1_100]);
    expect(watchScreen.mock.calls[0]?.[0]).toBe(request);
  });

  it("stops the stream at its source when the pane goes away", async () => {
    const stream = feed();
    let signal: AbortSignal | undefined;
    const watchScreen = vi.fn(async (_request: unknown, given?: AbortSignal) => {
      signal = given;
      return {
        status: "watching" as const,
        screen: { width: 1, height: 1 },
        frames: stream.frames,
      };
    });
    const client = clientWatching(watchScreen);
    const { unmount } = renderHook(() =>
      useAppleSimulatorLiveScreen({ client, request, enabled: true, decode }),
    );
    await waitFor(() => expect(watchScreen).toHaveBeenCalled());

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("says why there is no live view so the captured still can show instead", async () => {
    const watchScreen = vi.fn(async () => ({
      status: "failed" as const,
      kind: "unavailable" as const,
      message: "A live Simulator view needs the Octant desktop app.",
    }));
    const client = clientWatching(watchScreen);
    const { result } = renderHook(() =>
      useAppleSimulatorLiveScreen({ client, request, enabled: true, decode }),
    );

    await waitFor(() =>
      expect(result.current).toEqual({
        status: "unavailable",
        message: "A live Simulator view needs the Octant desktop app.",
      }),
    );
    expect(watchScreen).toHaveBeenCalledTimes(1);
  });

  it("asks again when a view ends on its own", async () => {
    const first = feed();
    const second = feed();
    const watchScreen = vi
      .fn()
      .mockResolvedValueOnce({
        status: "watching",
        screen: { width: 1206, height: 2622 },
        frames: first.frames,
      })
      .mockResolvedValueOnce({
        status: "watching",
        screen: { width: 1206, height: 2622 },
        frames: second.frames,
      });
    const client = clientWatching(watchScreen as AppleToolchainClient["watchScreen"]);
    const { result } = renderHook(() =>
      useAppleSimulatorLiveScreen({ client, request, enabled: true, decode }),
    );
    first.push(Uint8Array.from([1]));
    await waitFor(() => expect(result.current.status).toBe("live"));

    first.end();
    await waitFor(() => expect(watchScreen).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    second.push(Uint8Array.from([2]));

    await waitFor(() => expect(result.current.status).toBe("live"));
  });
});
