import { AggregateVersion, type EventActor, type UtcTimestamp } from "@octant/contracts";
import {
  MAX_CANVAS_EXPORT_FOLDER_OVERRIDES,
  CANVAS_EXPORT_FOLDER_AGGREGATE_TYPE,
  CANVAS_EXPORT_FOLDER_CHANGED,
  decodeCanvasExportFolderResult,
  decodeCanvasExportFolderSettings,
  type CanvasExportFolderRefusalReason,
  type CanvasExportFolderResult,
  type CanvasExportFolderScope,
  type CanvasExportFolderSettings,
} from "@octant/contracts/canvas-export-folder";
import {
  canvasExportFolderRefusalText,
  judgeCanvasExportFolder,
  resolveCanvasExportFolder,
} from "@octant/domain";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import {
  CANVAS_EXPORT_FOLDER_AGGREGATE_ID,
  CanvasExportFolderChanged,
} from "./canvasExportFolderEventStore";
import { isInsideHomeDirectory } from "./artifactMirrorFilePort";
import type { CanvasExportFilePort } from "./canvasExportFilePort";

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeFolderChanged = Schema.decodeUnknownSync(CanvasExportFolderChanged);

type JournalPort = Pick<Journal, "append" | "replayAggregate">;

export interface CanvasExportFolderServiceDependencies {
  readonly journal: JournalPort;
  readonly uuid: () => string;
  readonly actor: EventActor;
  readonly clock: () => UtcTimestamp;
  readonly files: Pick<CanvasExportFilePort, "isWritableFolder">;
  readonly home: string;
  /**
   * The standing access-outside-project grant. The host has no surface to give
   * it yet, so it is false and an outside-home folder is refused.
   */
  readonly standingOutsideApproval: boolean;
}

/**
 * Where each Project's exports go.
 *
 * A choice is journaled and rebuilt on restart, so a folder a person picked
 * survives one, and the folder is judged before it is stored: a folder outside
 * home without the standing grant, or a folder that cannot be written, is
 * refused here rather than discovered during a write.
 */
export class CanvasExportFolderService {
  readonly #dependencies: CanvasExportFolderServiceDependencies;
  #settings: CanvasExportFolderSettings;

  constructor(dependencies: CanvasExportFolderServiceDependencies) {
    this.#dependencies = dependencies;
    this.#settings = decodeCanvasExportFolderSettings({
      kind: "canvas-export-folder-settings",
      overrides: [],
      version: 0,
      updatedAt: dependencies.clock(),
    });
    this.#hydrate();
  }

  settings(): CanvasExportFolderSettings {
    return this.#settings;
  }

  /** The folder one Project exports to, the host's fallback included. */
  folderFor(projectId: string | undefined): string | undefined {
    return resolveCanvasExportFolder(this.#settings, projectId);
  }

  /**
   * Record the folder a person chose, for one Project or for the host.
   *
   * The path arrives already resolved from the host's own folder browser; this
   * is where it is judged, journaled, and made durable.
   */
  choose(input: {
    readonly scope: CanvasExportFolderScope;
    /** The Project to remember it for. Required for the project scope. */
    readonly projectId?: string;
    readonly folder: string;
    readonly expectedVersion: number;
  }): CanvasExportFolderResult {
    if (input.scope === "project" && input.projectId === undefined) {
      return this.#refused(
        "canvas-unavailable",
        "That Canvas has no Project to remember an export folder for.",
      );
    }
    if (input.expectedVersion !== this.#settings.version) {
      return this.#refused("stale-version", "The export folder changed since you read it.");
    }
    const verdict = judgeCanvasExportFolder({
      folder: input.folder,
      writable: this.#dependencies.files.isWritableFolder(input.folder),
      insideHome: isInsideHomeDirectory(input.folder, this.#dependencies.home),
      standingOutsideApproval: this.#dependencies.standingOutsideApproval,
    });
    if (verdict.status === "refused") {
      return this.#refused(verdict.reason, canvasExportFolderRefusalText(verdict.reason));
    }

    const others = this.#settings.overrides.filter(
      (override) => String(override.projectId) !== String(input.projectId ?? ""),
    );
    // The contract holds one choice per Project up to the bound; making room
    // for a new Project drops the oldest override, because old Projects cannot
    // crowd out new ones — a full bound must not wedge every later choice.
    const retained =
      others.length >= MAX_CANVAS_EXPORT_FOLDER_OVERRIDES
        ? others.slice(others.length - MAX_CANVAS_EXPORT_FOLDER_OVERRIDES + 1)
        : others;
    const next = decodeCanvasExportFolderSettings({
      kind: "canvas-export-folder-settings",
      ...(input.scope === "host"
        ? { fallback: input.folder, overrides: this.#settings.overrides }
        : {
            ...(this.#settings.fallback === undefined ? {} : { fallback: this.#settings.fallback }),
            overrides: [...retained, { projectId: input.projectId, folder: input.folder }],
          }),
      version: decodeAggregateVersion(this.#settings.version + 1),
      updatedAt: this.#dependencies.clock(),
    });
    try {
      this.#append(next);
    } catch (error) {
      if (error instanceof ConcurrencyConflict) {
        return this.#refused("stale-version", "The export folder changed since you read it.");
      }
      throw error;
    }
    this.#settings = next;
    return decodeCanvasExportFolderResult({
      kind: "canvas-export-folder-settings",
      settings: next,
    });
  }

  #append(settings: CanvasExportFolderSettings): void {
    this.#dependencies.journal.append({
      aggregate: {
        aggregateType: CANVAS_EXPORT_FOLDER_AGGREGATE_TYPE,
        aggregateId: CANVAS_EXPORT_FOLDER_AGGREGATE_ID,
      },
      expectedVersion: this.#settings.version,
      events: [
        {
          eventId: this.#dependencies.uuid(),
          eventName: CANVAS_EXPORT_FOLDER_CHANGED,
          eventVersion: 1,
          correlationId: this.#dependencies.uuid(),
          actor: this.#dependencies.actor,
          occurredAt: this.#dependencies.clock(),
          payload: { settings },
        },
      ],
    });
  }

  /** Rebuild the last stored choice from the journal, oldest frame to newest. */
  #hydrate(): void {
    let afterVersion = 0;
    let latest: CanvasExportFolderSettings | undefined;
    for (;;) {
      const batch = this.#dependencies.journal.replayAggregate({
        aggregateType: CANVAS_EXPORT_FOLDER_AGGREGATE_TYPE,
        aggregateId: CANVAS_EXPORT_FOLDER_AGGREGATE_ID,
        afterVersion,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const envelope of batch) {
        afterVersion = envelope.aggregateVersion;
        if (envelope.eventName !== CANVAS_EXPORT_FOLDER_CHANGED) continue;
        try {
          latest = decodeFolderChanged(envelope.payload).settings;
        } catch {
          // A frame that no longer decodes is not rewritten into a folder
          // nobody chose; the journal stays authoritative.
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    if (latest !== undefined) this.#settings = latest;
  }

  #refused(reason: CanvasExportFolderRefusalReason, message: string): CanvasExportFolderResult {
    return decodeCanvasExportFolderResult({
      kind: "canvas-export-folder-refused",
      reason,
      message,
    });
  }
}
