import { AggregateId, CanvasExportFolderSettings } from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import { CANVAS_EXPORT_FOLDER_CHANGED } from "@octant/contracts/canvas-export-folder";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One host-wide settings aggregate.
 *
 * The folder is one value per scope, so the aggregate id is fixed and the
 * version is the state machine's: a change reads the version it saw, so two
 * windows cannot quietly overwrite each other's choice.
 */
export const CANVAS_EXPORT_FOLDER_AGGREGATE_ID = Schema.decodeUnknownSync(AggregateId)(
  "00000000-0000-4000-8000-0000000000c5",
);

/** The whole settings document is the frame; the last one wins on replay. */
export const CanvasExportFolderChanged = Schema.Struct({
  settings: CanvasExportFolderSettings,
}).annotations(strict);

export function registerCanvasExportFolderEvents(registry: EventRegistry): EventRegistry {
  return registry.register(CANVAS_EXPORT_FOLDER_CHANGED, 1, CanvasExportFolderChanged);
}
