// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { ThreadVideoClips } from "./ThreadVideoClips";

const { cache, remove } = vi.hoisted(() => ({ cache: vi.fn(), remove: vi.fn() }));
vi.mock("./videoClipCache", () => ({ cacheVideoClip: cache }));
vi.mock("react-native", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("react-native-web")),
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("expo", () => ({ useEvent: () => ({ status: "readyToPlay" }) }));
vi.mock("expo-video", () => ({
  useVideoPlayer: () => ({ status: "readyToPlay" }),
  VideoView: () => createElement("div", { "data-testid": "video-playing" }),
}));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("keeps a downloaded clip through reconnection and clears it when access is lost", async () => {
  vi.useFakeTimers();
  cache.mockResolvedValue({ uri: "file:///cache/clip.mp4", exists: true, delete: remove });
  const threadId = "e4000000-0000-4000-8000-000000000002";
  const options = { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true };
  const jobs = [
    {
      id: "e4000000-0000-4000-8000-000000000003",
      status: "completed",
      threadKind: "work-thread",
      scopeId: threadId,
      profileInstanceId: "e4000000-0000-4000-8000-000000000001",
      driverKind: "gemini-video",
      modelId: "gemini-omni-1.2-flash",
      promptHash: "a".repeat(64),
      options,
      imageCount: 0,
      estimatedCostUsdMicros: 695_040,
      clip: {
        clipId: "e4000000-0000-4000-8000-000000000004",
        hash: "b".repeat(64),
        size: 100,
        durationSeconds: options.durationSeconds,
        resolution: options.resolution,
        aspectRatio: options.aspectRatio,
      },
      providerCopy: "removed",
      version: 2,
      createdAt: "2026-11-22T12:00:00.000Z",
      updatedAt: "2026-11-22T12:00:00.000Z",
    },
  ];
  let listStatus = 200;
  const transport: MobileRemoteTransport = {
    hostId: "host",
    authenticatedFetch: async () =>
      listStatus === 200 ? Response.json({ jobs }) : new Response(null, { status: listStatus }),
  };
  const node = document.createElement("div");
  const root = createRoot(node);
  const playing = () => node.querySelector('[data-testid="video-playing"]');
  const poll = async (status: number) => {
    listStatus = status;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
  };
  const render = async (transport: MobileRemoteTransport | undefined) =>
    act(async () =>
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          children: createElement(ThreadVideoClips, {
            hostId: "host",
            transport,
            threadId,
            threadKind: "work-thread",
          }),
        }),
      ),
    );
  try {
    await render(transport);
    await act(async () => node.querySelector<HTMLElement>('[aria-label="Open video"]')?.click());
    const player = playing();
    expect(player).not.toBeNull();
    await render(undefined);
    await poll(503);
    expect(playing()).toBe(player);
    expect(remove).not.toHaveBeenCalled();
    const reconnectFetch = vi.fn(transport.authenticatedFetch);
    await render({ ...transport, authenticatedFetch: reconnectFetch });
    await poll(503);
    expect(reconnectFetch).toHaveBeenCalledOnce();
    expect(playing()).toBe(player);
    expect(remove).not.toHaveBeenCalled();
    await poll(200);
    expect(cache).toHaveBeenCalledOnce();
    await poll(404);
    expect(playing()).toBeNull();
    expect(remove).toHaveBeenCalledOnce();
    await poll(503);
    expect(node.querySelector('[aria-label="Open video"]')).toBeNull();
    await poll(200);
    expect(node.querySelector('[aria-label="Open video"]')).not.toBeNull();
    expect(cache).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
