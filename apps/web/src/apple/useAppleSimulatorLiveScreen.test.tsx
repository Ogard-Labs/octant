import type { AppleToolchainClient } from "@octant/client-runtime/apple-toolchain-client";
import type { AppleScreenStreamRequest } from "@octant/contracts/apple-toolchain-rpc";
import { act, renderHook, waitFor } from "@testing-library/react";
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

  it("throws away a frame that finishes decoding after the pane moved on", async () => {
    const stream = feed();
    const watchScreen = vi.fn(async (_request: unknown, _signal?: AbortSignal) => ({
      status: "watching" as const,
      screen: { width: 1206, height: 2622 },
      frames: stream.frames,
    }));
    let finishDecode!: (frame: { width: number; height: number; close: () => void }) => void;
    const slowDecode = vi.fn(
      () =>
        new Promise<{ width: number; height: number; close: () => void }>((resolve) => {
          finishDecode = resolve;
        }),
    );
    const client = clientWatching(watchScreen);
    const { result, unmount } = renderHook(() =>
      useAppleSimulatorLiveScreen({ client, request, enabled: true, decode: slowDecode }),
    );
    stream.push(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
    await waitFor(() => expect(slowDecode).toHaveBeenCalled());
    const statusBefore = result.current.status;

    unmount();
    const close = vi.fn();
    finishDecode({ width: 506, height: 1_100, close });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statusBefore).toBe("connecting");
    // The decoded picture belongs to a view nobody is looking at: it is released.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops being live the moment it is pointed at another Simulator", async () => {
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
        screen: { width: 2064, height: 2752 },
        frames: second.frames,
      });
    const client = clientWatching(watchScreen as AppleToolchainClient["watchScreen"]);
    const other = {
      kind: "apple-screen-stream-request",
      simulatorId: "D1F82AC7-3B5F-455D-AFBF-93D12CBFCE6D",
    } as unknown as AppleScreenStreamRequest;
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ target }) => {
        const live = useAppleSimulatorLiveScreen({
          client,
          request: target,
          enabled: true,
          decode,
        });
        seen.push(live.status === "live" ? `live ${live.screen.width}` : live.status);
        return live;
      },
      { initialProps: { target: request } },
    );
    first.push(Uint8Array.from([1]));
    await waitFor(() => expect(result.current.status).toBe("live"));

    seen.length = 0;
    rerender({ target: other });

    // Not one render shows the first device's size under the second one's name.
    expect(seen[0]).toBe("connecting");
    second.push(Uint8Array.from([2]));
    await waitFor(() =>
      expect(result.current).toMatchObject({ status: "live", screen: { width: 2064 } }),
    );
    expect(seen).not.toContain("live 1206");
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

  it("gives up on a view that keeps dying right after its first frame, so the still can show", async () => {
    vi.useFakeTimers();
    async function* oneFrameThenGone() {
      yield Uint8Array.from([1]);
    }
    const watchScreen = vi.fn(async () => ({
      status: "watching" as const,
      screen: { width: 1206, height: 2622 },
      frames: oneFrameThenGone(),
    }));
    const client = clientWatching(watchScreen);
    const { result } = renderHook(() =>
      useAppleSimulatorLiveScreen({ client, request, enabled: true, decode }),
    );

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay + 50);
      });
    }

    // The first try and three more; a first frame alone does not earn a fresh count.
    expect(watchScreen).toHaveBeenCalledTimes(4);
    expect(result.current).toEqual({
      status: "unavailable",
      message: "The live Simulator view stopped.",
    });
  });
});
