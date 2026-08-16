import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { createThemeClient, ThemeClientFailure } from "./themeClient";

const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const bootstrap = { settings: DEFAULT_THEME_SETTINGS, version: 0 };

describe("ThemeClient", () => {
  it("loads bootstrap and posts an update through the authenticated route", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({
            kind: "theme-settings-replaced",
            settings: DEFAULT_THEME_SETTINGS,
            version: 1,
          })
        : Response.json(bootstrap),
    );
    const client = createThemeClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    await expect(client.bootstrap()).resolves.toEqual(bootstrap);
    await expect(
      client.execute({
        kind: "update-theme-settings",
        expectedVersion: 0 as never,
        settings: DEFAULT_THEME_SETTINGS,
      }),
    ).resolves.toMatchObject({ version: 1 });
    expect(fetch).toHaveBeenLastCalledWith(
      "http://127.0.0.1:4310/api/theme/commands",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
  });

  it("preserves typed stale conflict details", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { category: "conflict", message: "stale", expectedVersion: 0, actualVersion: 1 },
        { status: 409 },
      ),
    );
    const client = createThemeClient({
      baseUrl: "http://127.0.0.1:4310",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: capability,
    });
    await expect(
      client.execute({
        kind: "update-theme-settings",
        expectedVersion: 0 as never,
        settings: DEFAULT_THEME_SETTINGS,
      }),
    ).rejects.toMatchObject({ category: "conflict", expectedVersion: 0, actualVersion: 1 });
    await expect(
      client.execute({
        kind: "update-theme-settings",
        expectedVersion: 0 as never,
        settings: DEFAULT_THEME_SETTINGS,
      }),
    ).rejects.toBeInstanceOf(ThemeClientFailure);
  });
});
