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

  it("carries a saved profile onto the current terminal font default", () => {
    const test = fixture();
    const legacyFamily = "'JetBrains Mono', 'SF Mono', Menlo, monospace";
    const withLegacy = (family: string) => ({
      settings: {
        ...DEFAULT_THEME_SETTINGS,
        mode: "dark" as const,
        typography: {
          ...DEFAULT_THEME_SETTINGS.typography,
          terminal: { ...DEFAULT_THEME_SETTINGS.typography.terminal, family },
        },
      },
      aggregateVersion: 4,
    });

    // Saving any appearance setting persisted the whole object, so this person
    // holds the old stack without ever having chosen a terminal font.
    test.setProjected(withLegacy(legacyFamily));
    const migrated = test.service.bootstrap();
    expect(migrated.settings.typography.terminal.family).toBe(
      DEFAULT_THEME_SETTINGS.typography.terminal.family,
    );
    expect(migrated.settings.mode).toBe("dark");
    expect(migrated.version).toBe(4);

    // A family they actually chose is theirs and is left exactly as saved.
    test.setProjected(withLegacy("'IBM Plex Mono', monospace"));
    expect(test.service.bootstrap().settings.typography.terminal.family).toBe(
      "'IBM Plex Mono', monospace",
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
