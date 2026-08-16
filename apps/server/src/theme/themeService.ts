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
} from "@octant/contracts";
import { resolveEffectiveTokens } from "@octant/theme";
import { Schema } from "effect";
import { ConcurrencyConflict, JournalWriteFailed } from "../persistence/journalErrors";
import type { PersistenceService } from "../persistence/persistenceService";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { THEME_SETTINGS_AGGREGATE_ID } from "../persistence/themeProjection";

const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

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
    },
  ) {}

  bootstrap(): ThemeBootstrap {
    this.assertReady();
    const projected = this.options.persistence.readThemeSettings();
    return decodeThemeBootstrap({
      settings: projected?.settings ?? DEFAULT_THEME_SETTINGS,
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
      const settings = command.settings;
      const resolved = resolveEffectiveTokens(settings, false);
      if (resolved.droppedOverrides.length > 0) {
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
          message: "Octant could not save appearance settings.",
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
