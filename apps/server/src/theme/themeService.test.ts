import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import type { PersistenceService } from "../persistence/persistenceService";
import { ThemeService, ThemeServiceError } from "./themeService";

function fixture() {
  let projected: { settings: typeof DEFAULT_THEME_SETTINGS; aggregateVersion: number } | undefined;
  const append = vi.fn();
  const persistence = {
    readThemeSettings: () => projected,
    status: () => ({ state: "current", integrity: "ok" }),
    journal: {
      append: vi.fn((input: unknown) => {
        append(input);
        return { aggregateVersion: 1 };
      }),
    },
  } as unknown as PersistenceService;
  const service = new ThemeService({
    persistence,
    uuid: randomUUID,
    clock: () => "2026-07-28T10:00:00.000Z",
  });
  return {
    persistence,
    service,
    append,
    setProjected: (next: typeof projected) => {
      projected = next;
    },
  };
}

describe("ThemeService", () => {
  it("bootstraps defaults and appends a complete, versioned update", () => {
    const test = fixture();
    expect(test.service.bootstrap()).toMatchObject({
      settings: DEFAULT_THEME_SETTINGS,
      version: 0,
    });
    const result = test.service.execute({
      kind: "update-theme-settings",
      expectedVersion: 0,
      settings: { ...DEFAULT_THEME_SETTINGS, mode: "dark" },
    });
    expect(result).toMatchObject({
      kind: "theme-settings-replaced",
      version: 1,
      settings: { mode: "dark" },
    });
    expect(test.append).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 0,
        events: [
          expect.objectContaining({
            eventName: "theme.settings-updated@1",
            payload: expect.objectContaining({ version: 1 }),
          }),
        ],
      }),
    );
  });

  it("rejects stale or invalid changes without journaling", () => {
    const test = fixture();
    test.setProjected({ settings: DEFAULT_THEME_SETTINGS, aggregateVersion: 2 });
    expect(() =>
      test.service.execute({
        kind: "update-theme-settings",
        expectedVersion: 1,
        settings: DEFAULT_THEME_SETTINGS,
      }),
    ).toThrowError(ThemeServiceError);
    expect(() =>
      test.service.execute({
        kind: "update-theme-settings",
        expectedVersion: 2,
        settings: {
          ...DEFAULT_THEME_SETTINGS,
          semanticOverrides: [{ role: "unknown", color: "#ffffff" }],
        },
      }),
    ).toThrowError(ThemeServiceError);
    expect(test.append).not.toHaveBeenCalled();
  });
});
