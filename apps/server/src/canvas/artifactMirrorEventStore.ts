import {
  ARTIFACT_MIRROR_AGGREGATE_TYPE,
  ARTIFACT_MIRROR_EVENT_NAMES,
  ArtifactMirrorReceipt,
  ArtifactMirrorSettings,
  CanvasId,
  CanvasVersionId,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The journal frames the mirror writes.
 *
 * A receipt is journaled for every outcome, including the ones where nothing
 * was written. That is what makes "why is there no file" answerable after the
 * fact rather than something to reproduce.
 */
export const ArtifactMirrorSettingChanged = Schema.Struct({
  settings: ArtifactMirrorSettings,
}).annotations(strict);

export const ArtifactMirrorWritten = Schema.Struct({
  receipt: ArtifactMirrorReceipt,
}).annotations(strict);

export const ArtifactMirrorReimported = Schema.Struct({
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  /** The file the new version came from, relative to its destination root. */
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);

export function registerArtifactMirrorEvents(registry: EventRegistry): EventRegistry {
  return registry
    .register(ARTIFACT_MIRROR_EVENT_NAMES.settingChanged, 1, ArtifactMirrorSettingChanged)
    .register(ARTIFACT_MIRROR_EVENT_NAMES.written, 1, ArtifactMirrorWritten)
    .register(ARTIFACT_MIRROR_EVENT_NAMES.reimported, 1, ArtifactMirrorReimported);
}

export interface ArtifactMirrorEventStoreOptions {
  readonly journal: Pick<Journal, "append">;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  readonly actor: { readonly kind: "system" | "local-user"; readonly actorId: string };
}

/**
 * Appends the mirror's frames.
 *
 * Every frame is written with `expectedVersion: 0` against its own aggregate
 * id, because these are records of what happened rather than transitions of a
 * state machine: two receipts for one artifact do not contend, and a mirror
 * write must never lose to a concurrency conflict with itself.
 */
export class ArtifactMirrorEventStore {
  readonly #options: ArtifactMirrorEventStoreOptions;

  constructor(options: ArtifactMirrorEventStoreOptions) {
    this.#options = options;
  }

  append(input: {
    readonly aggregateId: string;
    readonly eventName: string;
    readonly payload: unknown;
  }): void {
    this.#options.journal.append({
      aggregate: {
        aggregateType: ARTIFACT_MIRROR_AGGREGATE_TYPE,
        aggregateId: input.aggregateId,
      },
      expectedVersion: 0,
      events: [
        {
          eventId: this.#options.uuid(),
          eventName: input.eventName,
          eventVersion: 1,
          actor: this.#options.actor,
          occurredAt: this.#options.clock(),
          payload: input.payload,
        },
      ],
    });
  }
}
