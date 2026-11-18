import {
  AggregateVersion,
  ActorId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  DEFAULT_THEME_SETTINGS,
  decodeThemeBootstrap,
  decodeThemeCommand,
  type ThemeBootstrap,
  type ThemeCommandResult,
  type ThemeFailure,
  type ThemeSettings,
} from "@octant/contracts";
import { resolveEffectiveTokens, type ThemePreset } from "@octant/theme";
import { Schema } from "effect";
import {
  ConcurrencyConflict,
  JournalWriteFailed,
  persistenceFailureMessage,
} from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { THEME_SETTINGS_AGGREGATE_ID } from "../persistence/themeProjection";

const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * Checks the overrides in the mode the theme resolves to, and also in every
 * mode a scoped override names. Resolving one mode alone skipped a dark-only
 * override while the theme followed the system, so the server accepted a
 * colour the renderer then dropped in dark mode.
 *
 * The overrides are checked against the theme the person selected, including
 * an effective plugin theme; checking against the default alone accepted a
 * colour the renderer then dropped on the plugin theme's surfaces. A selected
 * plugin theme that is not effective resolves to the default, as it draws.
 */
function overridesDroppedInAnyShownMode(
  settings: ThemeSettings,
  contributedThemes: ReadonlyArray<ThemePreset>,
): boolean {
  const modes = new Set<"light" | "dark" | undefined>([undefined]);
  for (const entry of settings.semanticOverrides) {
    if (entry.mode !== undefined) modes.add(entry.mode);
  }
  return [...modes].some(
    (mode) =>
      resolveEffectiveTokens(
        mode === undefined ? settings : { ...settings, mode },
        false,
        contributedThemes,
      ).droppedOverrides.length > 0,
  );
}

export interface ThemeServiceApi {
  readonly bootstrap: () => ThemeBootstrap;
  readonly execute: (input: unknown) => ThemeCommandResult;
}

export class ThemeServiceError extends Error {
  override readonly name = "ThemeServiceError";
  constructor(readonly failure: ThemeFailure) {
    super(failure.message);
  }
}

export class ThemeService implements ThemeServiceApi {
  constructor(
    private readonly options: {
      readonly persistence: PersistenceService;
      readonly uuid: () => string;
      readonly clock: () => string;
      /** The plugin themes the renderer may draw: effective components only. */
      readonly contributedThemes: () => ReadonlyArray<ThemePreset>;
    },
  ) {}

  bootstrap(): ThemeBootstrap {
    this.assertReady();
    const projected = this.options.persistence.readThemeSettings();
    return decodeThemeBootstrap({
      settings:
        projected === undefined
          ? DEFAULT_THEME_SETTINGS
          : withCurrentFontDefaults(projected.settings),
      version: projected?.aggregateVersion ?? 0,
    });
  }

  execute(input: unknown): ThemeCommandResult {
    let command: ReturnType<typeof decodeThemeCommand>;
    try {
      command = decodeThemeCommand(input);
    } catch {
      throw new ThemeServiceError({ category: "invalid", message: "Theme command is invalid." });
    }
    this.assertReady();
    try {
      const projected = this.options.persistence.readThemeSettings();
      const currentVersion = projected?.aggregateVersion ?? 0;
      const expectedVersion = command.expectedVersion ?? currentVersion;
      if (expectedVersion !== currentVersion) {
        throw new ThemeServiceError({
          category: "conflict",
          message: "Appearance settings changed; reload before applying your draft.",
          expectedVersion: decodeAggregateVersion(expectedVersion),
          actualVersion: decodeAggregateVersion(currentVersion),
        });
      }
      // A save always carries the smoothing choice, so a row written by this
      // build is told apart from one written before the choice existed (see
      // withCurrentDefaults).
      const settings: ThemeSettings =
        command.settings.fontSmoothing === undefined
          ? { ...command.settings, fontSmoothing: "on" }
          : command.settings;
      if (overridesDroppedInAnyShownMode(settings, this.options.contributedThemes())) {
        throw new ThemeServiceError({
          category: "invalid",
          message: "One or more semantic color overrides fail contrast or role validation.",
        });
      }
      const nextVersion = currentVersion + 1;
      this.options.persistence.journal.append({
        aggregate: { aggregateType: "theme-settings", aggregateId: THEME_SETTINGS_AGGREGATE_ID },
        expectedVersion,
        events: [
          {
            eventId: decodeEventId(this.options.uuid()),
            eventName: "theme.settings-updated@1",
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.options.uuid()),
            actor: {
              kind: "system",
              actorId: decodeActorId("00000000-0000-4000-8000-000000000002"),
            },
            occurredAt: decodeTimestamp(this.options.clock()),
            payload: { settings, version: nextVersion, updatedAt: this.options.clock() },
          },
        ],
      });
      return {
        kind: "theme-settings-replaced",
        settings,
        version: decodeAggregateVersion(nextVersion),
      };
    } catch (error) {
      if (error instanceof ThemeServiceError) throw error;
      if (error instanceof ConcurrencyConflict) {
        throw new ThemeServiceError({
          category: "conflict",
          message: "Appearance settings changed; reload before applying your draft.",
          expectedVersion: decodeAggregateVersion(error.expectedVersion),
          actualVersion: decodeAggregateVersion(error.actualVersion),
        });
      }
      if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
        throw new ThemeServiceError({
          category: "unavailable",
          message: persistenceFailureMessage(error, "Octant could not save appearance settings."),
        });
      }
      throw new ThemeServiceError({
        category: "unavailable",
        message: "Appearance settings are unavailable.",
      });
    }
  }

  private assertReady(): void {
    const status = this.options.persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw new ThemeServiceError({
        category: "recovery-required",
        message: "Octant storage requires recovery before appearance settings can change.",
      });
    }
  }
}

/**
 * The terminal font stack persisted before Nerd Font fallbacks were added.
 *
 * The projection stores the whole settings object, so anyone who ever saved an
 * appearance setting kept this exact stack even though they never chose it.
 * Only this one literal is replaced; a family the person actually typed is
 * theirs and is left alone.
 */
const LEGACY_DEFAULT_TERMINAL_FONT_FAMILY = "'JetBrains Mono', 'SF Mono', Menlo, monospace";
const LEGACY_DEFAULT_UI_FONT_FAMILY =
  "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

/**
 * The interface size every row carried while 13 was the default.
 *
 * The default became 14, and a person who had ever saved an appearance setting
 * kept 13 without having chosen it (a maintainer's own profile stayed at 13
 * through three builds that were meant to be larger, 2026-11-16). A row with
 * no smoothing choice was written before that choice existed, so its 13 is the
 * old default and reads as the current one. Every save since carries the
 * smoothing choice, so a 13 saved from now on is a person's own and stays.
 */
const LEGACY_DEFAULT_UI_FONT_SIZE = 13;

function withCurrentFontDefaults(settings: ThemeSettings): ThemeSettings {
  const { ui, terminal } = settings.typography;
  const uiIsLegacy = ui.family === LEGACY_DEFAULT_UI_FONT_FAMILY;
  const terminalIsLegacy = terminal.family === LEGACY_DEFAULT_TERMINAL_FONT_FAMILY;
  const sizeIsLegacy =
    settings.fontSmoothing === undefined && ui.size === LEGACY_DEFAULT_UI_FONT_SIZE;
  if (!uiIsLegacy && !terminalIsLegacy && !sizeIsLegacy) return settings;
  const sized = sizeIsLegacy ? { ...ui, size: DEFAULT_THEME_SETTINGS.typography.ui.size } : ui;
  return {
    ...settings,
    typography: {
      ...settings.typography,
      ui: uiIsLegacy ? { ...sized, family: DEFAULT_THEME_SETTINGS.typography.ui.family } : sized,
      terminal: terminalIsLegacy
        ? { ...terminal, family: DEFAULT_THEME_SETTINGS.typography.terminal.family }
        : terminal,
    },
  };
}
