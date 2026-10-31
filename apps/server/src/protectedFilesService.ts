import type { EventActor, UtcTimestamp } from "@octant/contracts";
import {
  BUILT_IN_PROTECTED_FILES_REMOVED,
  BUILT_IN_PROTECTED_FILES_RESTORED,
  BuiltInProtectedFilesRemoved,
  BuiltInProtectedFilesRestored,
  PROTECTED_FILES_AGGREGATE_TYPE,
  PROTECTED_PATH_ADDED,
  PROTECTED_PATH_REMOVED,
  ProtectedPathAdded,
  ProtectedPathRemoved,
  decodeProtectedFilesResult,
  decodeProtectedFilesSettings,
  type BuiltInProtectedFilesId,
  type ProtectedFilesCommand,
  type ProtectedFilesResult,
  type ProtectedFilesSettings,
} from "@octant/contracts/protected-files";
import {
  builtInProtectedFiles,
  protectedEntryDisplay,
  resolveProtectedFiles,
  type ProtectedFilesChoice,
  type ProtectedFilesLocations,
} from "@octant/domain/secret-guard-policy";
import { Schema } from "effect";
import type { EventRegistry } from "./persistence/eventRegistry";
import type { Journal } from "./persistence/journal";
import { ConcurrencyConflict } from "./persistence/journalErrors";
import { replayAggregateTypesInOrder } from "./persistence/journalHydration";

/** The one aggregate the host's protected list lives in. */
const PROTECTED_FILES_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000d7";

const decodeAdded = Schema.decodeUnknownSync(ProtectedPathAdded);
const decodeRemoved = Schema.decodeUnknownSync(ProtectedPathRemoved);
const decodeBuiltInRemoved = Schema.decodeUnknownSync(BuiltInProtectedFilesRemoved);
const decodeBuiltInRestored = Schema.decodeUnknownSync(BuiltInProtectedFilesRestored);

export function registerProtectedFilesEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(PROTECTED_PATH_ADDED, 1, ProtectedPathAdded)
    .register(PROTECTED_PATH_REMOVED, 1, ProtectedPathRemoved)
    .register(BUILT_IN_PROTECTED_FILES_REMOVED, 1, BuiltInProtectedFilesRemoved)
    .register(BUILT_IN_PROTECTED_FILES_RESTORED, 1, BuiltInProtectedFilesRestored);
}

export interface ProtectedFilesServiceDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly locations: ProtectedFilesLocations;
  /** Told the person's changes, so every later launch carries them. */
  readonly apply: (choice: ProtectedFilesChoice) => void;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: EventActor;
}

/**
 * The secret guard's list as the person changed it in Settings › Permissions ›
 * Protected files. Every change is journaled; removing a built-in group is
 * journaled with the confirmation the window asked for, so the record shows
 * the person was warned. The built-in list itself is not stored: a journal
 * holds only changes, and an Octant that adds a new built-in protects it on
 * every host whatever was removed before.
 */
export class ProtectedFilesService {
  readonly #dependencies: ProtectedFilesServiceDependencies;
  #added: ReadonlyArray<string> = [];
  #removed: ReadonlyArray<BuiltInProtectedFilesId> = [];
  #version = 0;
  #updatedAt: UtcTimestamp | undefined;

  constructor(dependencies: ProtectedFilesServiceDependencies) {
    this.#dependencies = dependencies;
    this.#hydrate();
    this.#dependencies.apply(this.choice());
  }

  choice(): ProtectedFilesChoice {
    return { added: this.#added, removed: this.#removed };
  }

  settings(): ProtectedFilesSettings {
    const { locations } = this.#dependencies;
    const removed = new Set(this.#removed);
    return decodeProtectedFilesSettings({
      kind: "protected-files-settings",
      builtIns: builtInProtectedFiles(locations.platform).map((rule) => ({
        id: rule.id,
        label: rule.label,
        channel: rule.channel,
        removed: removed.has(rule.id),
        paths: resolveProtectedFiles(locations, { added: [], removed: [] })
          .filter((entry) => entry.ruleId === rule.id)
          .map((entry) => protectedEntryDisplay(entry, locations.home)),
      })),
      added: this.#added,
      version: this.#version,
      ...(this.#updatedAt === undefined ? {} : { updatedAt: this.#updatedAt }),
    });
  }

  change(command: ProtectedFilesCommand): ProtectedFilesResult {
    if (command.expectedVersion !== this.#version) {
      return refused("stale-version", "The protected files changed since you read them.");
    }
    const event = this.#eventFor(command);
    if (event === undefined) {
      return refused("no-change", "That change is already in place.");
    }
    try {
      this.#dependencies.journal.append({
        aggregate: {
          aggregateType: PROTECTED_FILES_AGGREGATE_TYPE,
          aggregateId: PROTECTED_FILES_AGGREGATE_ID,
        },
        expectedVersion: this.#version,
        events: [
          {
            eventId: this.#dependencies.uuid(),
            eventName: event.name,
            eventVersion: 1,
            correlationId: this.#dependencies.uuid(),
            actor: this.#dependencies.actor,
            occurredAt: this.#dependencies.clock(),
            payload: event.payload,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        return refused("stale-version", "The protected files changed since you read them.");
      }
      throw error;
    }
    this.#apply(event.name, event.payload);
    this.#version += 1;
    this.#updatedAt = this.#dependencies.clock();
    this.#dependencies.apply(this.choice());
    return decodeProtectedFilesResult({
      kind: "protected-files-settings",
      settings: this.settings(),
    });
  }

  #eventFor(
    command: ProtectedFilesCommand,
  ): { readonly name: string; readonly payload: unknown } | undefined {
    switch (command.kind) {
      case "add-protected-path":
        return this.#added.includes(command.path)
          ? undefined
          : { name: PROTECTED_PATH_ADDED, payload: { path: command.path } };
      case "remove-protected-path":
        return this.#added.includes(command.path)
          ? { name: PROTECTED_PATH_REMOVED, payload: { path: command.path } }
          : undefined;
      case "remove-built-in-protected-files":
        return this.#removed.includes(command.id)
          ? undefined
          : {
              name: BUILT_IN_PROTECTED_FILES_REMOVED,
              payload: { id: command.id, confirmed: command.confirmed },
            };
      case "restore-built-in-protected-files":
        return this.#removed.includes(command.id)
          ? { name: BUILT_IN_PROTECTED_FILES_RESTORED, payload: { id: command.id } }
          : undefined;
    }
  }

  #apply(name: string, payload: unknown): void {
    switch (name) {
      case PROTECTED_PATH_ADDED: {
        const { path } = decodeAdded(payload);
        if (!this.#added.includes(path)) this.#added = [...this.#added, path];
        return;
      }
      case PROTECTED_PATH_REMOVED: {
        const { path } = decodeRemoved(payload);
        this.#added = this.#added.filter((entry) => entry !== path);
        return;
      }
      case BUILT_IN_PROTECTED_FILES_REMOVED: {
        const { id } = decodeBuiltInRemoved(payload);
        if (!this.#removed.includes(id)) this.#removed = [...this.#removed, id];
        return;
      }
      case BUILT_IN_PROTECTED_FILES_RESTORED: {
        const { id } = decodeBuiltInRestored(payload);
        this.#removed = this.#removed.filter((entry) => entry !== id);
        return;
      }
    }
  }

  #hydrate(): void {
    for (const envelope of replayAggregateTypesInOrder(this.#dependencies.journal, [
      PROTECTED_FILES_AGGREGATE_TYPE,
    ])) {
      this.#apply(envelope.eventName, envelope.payload);
      this.#version = envelope.aggregateVersion;
      this.#updatedAt = envelope.occurredAt;
    }
  }
}

function refused(
  reason: "malformed" | "stale-version" | "unauthorized" | "no-change",
  message: string,
): ProtectedFilesResult {
  return decodeProtectedFilesResult({ kind: "protected-files-refused", reason, message });
}
