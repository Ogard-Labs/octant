import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkSettings } from "./useWorkSettings";

const settings = {
  defaultAccess: "ask-first",
  version: 3,
  updatedAt: "2026-09-25T12:00:00.000Z",
} as const;

function client(overrides: { settings?: unknown; execute?: () => Promise<unknown> } = {}) {
  return {
    bootstrap: vi.fn(async () => ({
      ...("settings" in overrides ? { settings: overrides.settings } : { settings }),
    })),
    execute: vi.fn(
      overrides.execute ??
        (async () => ({ kind: "settings-updated", settings: { ...settings, version: 4 } })),
    ),
  } as never as Parameters<typeof useWorkSettings>[0] & {
    readonly bootstrap: ReturnType<typeof vi.fn>;
    readonly execute: ReturnType<typeof vi.fn>;
  };
}

describe("useWorkSettings", () => {
  it("says Work settings are unavailable when the host has none, instead of loading forever", async () => {
    const { result } = renderHook(() => useWorkSettings(client({ settings: undefined })));

    await waitFor(() => expect(result.current.status).toBe("unsupported"));
    expect(result.current.message).toBe("Work settings are unavailable on this host.");
  });

  it("reads the settings again when another window's save is announced", async () => {
    const work = client();
    const { result, rerender } = renderHook(({ revision }) => useWorkSettings(work, revision), {
      initialProps: { revision: 1 },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ revision: 2 });
    await waitFor(() => expect(work.bootstrap).toHaveBeenCalledTimes(2));
  });

  it("sends one save at a time, so a quick second change cannot reuse a stale version", async () => {
    let finish: (value: unknown) => void = () => {};
    const work = client({
      execute: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const { result } = renderHook(() => useWorkSettings(work));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let second: Promise<boolean> | undefined;
    act(() => {
      void result.current.update({ defaultAccess: "auto-accept-edits" });
      second = result.current.update({ defaultAccess: "ask-first" });
    });
    await expect(second).resolves.toBe(false);
    expect(work.execute).toHaveBeenCalledOnce();
    await act(async () => {
      finish({ kind: "settings-updated", settings: { ...settings, version: 4 } });
    });
  });
});
