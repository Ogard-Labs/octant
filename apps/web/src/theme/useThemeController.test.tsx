import { ThemeClientFailure, type ThemeClient } from "@octant/client-runtime/theme-client";
import { DEFAULT_THEME_SETTINGS, type ThemeSettings } from "@octant/contracts/theme";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useThemeController } from "./useThemeController";

/**
 * A server that answers in the order it was asked, and refuses any write whose
 * expected version is not the one it currently holds — the same optimistic
 * concurrency the real control plane enforces.
 */
function versionedClient() {
  const seen: Array<{ mode: string; expectedVersion: number }> = [];
  let version = 1;
  // Cast at the seam: the client's own package publishes built types, so a
  // literal written against the source contracts is a structurally identical
  // but nominally different `ThemeSettings`.
  const client = {
    bootstrap: async () => ({ settings: DEFAULT_THEME_SETTINGS, version }),
    execute: async (command: { settings: ThemeSettings; expectedVersion: number }) => {
      seen.push({ mode: command.settings.mode, expectedVersion: command.expectedVersion });
      if (command.expectedVersion !== version) {
        throw new Error(`conflict: expected ${String(version)}`);
      }
      version += 1;
      return { settings: command.settings, version };
    },
  } as unknown as ThemeClient;
  return { client, seen };
}

function mount(client: ThemeClient) {
  return renderHook(() =>
    useThemeController({ client, serverUrl: "http://127.0.0.1:0", windowCapability: "test" }),
  );
}

describe("useThemeController", () => {
  it("updates the rendered draft before the authoritative save returns", async () => {
    let release: (() => void) | undefined;
    const client = {
      bootstrap: async () => ({ settings: DEFAULT_THEME_SETTINGS, version: 1 }),
      execute: async (command: { settings: ThemeSettings }) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { settings: command.settings, version: 2 };
      },
    } as unknown as ThemeClient;
    const view = mount(client);
    await waitFor(() => expect(view.result.current.status).toBe("ready"));

    let write: Promise<boolean> | undefined;
    act(() => {
      write = view.result.current.applyPatch({
        typography: {
          ...DEFAULT_THEME_SETTINGS.typography,
          ui: { ...DEFAULT_THEME_SETTINGS.typography.ui, size: 17 },
        },
      });
    });
    expect(view.result.current.draft?.typography.ui.size).toBe(17);

    await waitFor(() => expect(release).toBeTypeOf("function"));
    release?.();
    await act(async () => expect(await write).toBe(true));
  });

  it("does not let a second immediate change race the first", async () => {
    const { client, seen } = versionedClient();
    const view = mount(client);
    await waitFor(() => expect(view.result.current.status).toBe("ready"));

    // Two presses in one tick. Both are built from the same render, so without
    // a queue they claim the same version and the server rejects the second —
    // leaving whichever arrived first, not the one the user chose last.
    await act(async () => {
      const first = view.result.current.applyPatch({ mode: "light" });
      const second = view.result.current.applyPatch({ mode: "dark" });
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });

    expect(seen).toEqual([
      { mode: "light", expectedVersion: 1 },
      { mode: "dark", expectedVersion: 2 },
    ]);
    expect(view.result.current.settings?.mode).toBe("dark");
    expect(view.result.current.status).toBe("ready");
  });

  it("does not replace a newer optimistic preview when an older save completes", async () => {
    const releases: Array<() => void> = [];
    let version = 1;
    const client = {
      bootstrap: async () => ({ settings: DEFAULT_THEME_SETTINGS, version }),
      execute: async (command: { settings: ThemeSettings }) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        version += 1;
        return { settings: command.settings, version };
      },
    } as unknown as ThemeClient;
    const view = mount(client);
    await waitFor(() => expect(view.result.current.status).toBe("ready"));

    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    act(() => {
      first = view.result.current.applyPatch({ mode: "light" });
      second = view.result.current.applyPatch({ mode: "dark" });
    });
    expect(view.result.current.draft?.mode).toBe("dark");
    await waitFor(() => expect(releases).toHaveLength(1));

    releases[0]?.();
    await act(async () => expect(await first).toBe(true));
    await waitFor(() => expect(releases).toHaveLength(2));
    expect(view.result.current.draft?.mode).toBe("dark");

    releases[1]?.();
    await act(async () => expect(await second).toBe(true));
  });

  it("stands down a queued write once another window has won", async () => {
    const seen: Array<string> = [];
    const client = {
      bootstrap: async () => ({ settings: DEFAULT_THEME_SETTINGS, version: 1 }),
      execute: async (command: { settings: ThemeSettings }) => {
        seen.push(command.settings.mode);
        throw new ThemeClientFailure({
          category: "conflict",
          message: "Appearance changed elsewhere.",
          expectedVersion: 1 as never,
          actualVersion: 2 as never,
        });
      },
    } as unknown as ThemeClient;
    const view = mount(client);
    await waitFor(() => expect(view.result.current.status).toBe("ready"));

    await act(async () => {
      const first = view.result.current.applyPatch({ mode: "light" });
      const second = view.result.current.applyPatch({ mode: "dark" });
      expect(await first).toBe(false);
      expect(await second).toBe(false);
    });

    // A write replaces the whole record, so re-sending the queued one against
    // the reloaded version would put this window's stale values back.
    expect(seen).toEqual(["light"]);
  });

  it("saves the value pressed, not the draft as it stood before the press", async () => {
    const { client, seen } = versionedClient();
    const view = mount(client);
    await waitFor(() => expect(view.result.current.status).toBe("ready"));

    // `updateDraft` schedules a state update, so a control that takes effect on
    // press cannot save through the draft: it would save the previous value.
    await act(async () => {
      view.result.current.updateDraft({ mode: "light" });
      await view.result.current.applyPatch({ mode: "dark" });
    });

    expect(seen.map((write) => write.mode)).toEqual(["dark"]);
  });
});
