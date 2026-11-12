import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readBottomPanelPresentation,
  readSidebarCollapsed,
  useBackgroundImageLibrary,
  useAutomaticUpdateCheckSync,
  useQuitShortcutSecondPressSync,
  useReleaseRingSync,
  useSidebarBackgroundFetcher,
  writeBottomPanelPresentation,
  writeSidebarCollapsed,
} from "./useShellPresentation";

it("never forwards shared host update preferences into an application that owns its local choices", () => {
  const setAutomaticAppUpdateChecks = vi.fn(async () => {
    throw new Error("Unexpected shared preference");
  });
  const setAppUpdateRing = vi.fn(async () => {
    throw new Error("Unexpected shared preference");
  });
  const host = {
    appUpdatePreferenceScope: "local" as const,
    setAutomaticAppUpdateChecks,
    setAppUpdateRing,
  };
  renderHook(() => {
    useAutomaticUpdateCheckSync(host, true);
    useReleaseRingSync(host, "stable");
  });
  expect(setAutomaticAppUpdateChecks).not.toHaveBeenCalled();
  expect(setAppUpdateRing).not.toHaveBeenCalled();
});

it("tells the desktop app each time the person changes whether the quit shortcut needs a second press", () => {
  const setQuitShortcutSecondPress = vi.fn();
  const host = { setQuitShortcutSecondPress };
  const { rerender } = renderHook(
    ({ needed }: { readonly needed: boolean | undefined }) =>
      useQuitShortcutSecondPressSync(host, needed),
    { initialProps: { needed: undefined as boolean | undefined } },
  );
  // Settings not loaded yet: the desktop keeps its own default, guarded.
  expect(setQuitShortcutSecondPress).not.toHaveBeenCalled();

  rerender({ needed: false });
  rerender({ needed: true });

  expect(setQuitShortcutSecondPress.mock.calls).toEqual([[false], [true]]);
});

const windowCapability = `${"C".repeat(42)}A`;
const httpsServerUrl = "https://host.example:8443";

describe("sidebar collapsed persistence", () => {
  it("reads and writes the presentation preference without throwing when storage is missing", () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    } as unknown as Storage;

    expect(readSidebarCollapsed({})).toBe(false);
    expect(readSidebarCollapsed({ localStorage })).toBe(false);
    writeSidebarCollapsed({ localStorage }, true);
    expect(readSidebarCollapsed({ localStorage })).toBe(true);
    writeSidebarCollapsed({ localStorage }, false);
    expect(readSidebarCollapsed({ localStorage })).toBe(false);
  });
});

describe("bottom panel persistence", () => {
  it("keeps presentation state per window and clamps restored height", () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as unknown as Storage;

    expect(readBottomPanelPresentation({ localStorage }, "window-a")).toEqual({
      open: false,
      height: 260,
    });
    writeBottomPanelPresentation({ localStorage }, "window-a", { open: true, height: 340 });
    expect(readBottomPanelPresentation({ localStorage }, "window-a")).toEqual({
      open: true,
      height: 340,
    });
    expect(readBottomPanelPresentation({ localStorage }, "window-b")).toEqual({
      open: false,
      height: 260,
    });

    writeBottomPanelPresentation({ localStorage }, "window-a", { open: true, height: 9_000 });
    expect(readBottomPanelPresentation({ localStorage }, "window-a").height).toBe(640);
  });
});

describe("capability-bearing background fetches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not follow redirects when fetching a sidebar background with the window capability", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useSidebarBackgroundFetcher(httpsServerUrl, windowCapability),
    );
    await result.current("bg-1");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/theme/sidebar-backgrounds/bg-1", httpsServerUrl),
      expect.objectContaining({
        redirect: "error",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
  });

  it("treats a redirect error as a failed sidebar background fetch", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useSidebarBackgroundFetcher(httpsServerUrl, windowCapability),
    );
    await expect(result.current("bg-1")).rejects.toBeInstanceOf(TypeError);
  });

  it("does not follow redirects when listing background images with the window capability", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ backgrounds: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useBackgroundImageLibrary(httpsServerUrl, windowCapability, async () => new Blob()),
    );
    await result.current.list();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/theme/sidebar-backgrounds", httpsServerUrl),
      expect.objectContaining({
        redirect: "error",
        headers: { "x-octant-window-capability": windowCapability },
      }),
    );
  });
});
