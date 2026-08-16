import {
  ZenSpaceSnapshotRecorded,
  ZenWidgetMutationRecorded,
  type EventEnvelope,
  type ZenSpace,
  type ZenSpaceId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Projection } from "./projection";
import {
  ZEN_PROJECTION_SCHEMA_VERSION,
  decodePersistedZenSpace,
  type ZenSpaceProjectionRow,
} from "./zenPersistenceSchema";
import type { SqliteConnection } from "./sqlitePort";

export const ZEN_AGGREGATE_TYPE = "zen-space";

const ZEN_SPACE_SNAPSHOT_RECORDED_V1 = "zen.space-snapshot-recorded@1";
const ZEN_SPACE_SNAPSHOT_RECORDED_V2 = "zen.space-snapshot-recorded@2";
const ZEN_WIDGET_MUTATION_RECORDED = "zen.widget-mutation-recorded@1";
const decodeSnapshot = Schema.decodeUnknownSync(ZenSpaceSnapshotRecorded);
const decodeWidgetMutation = Schema.decodeUnknownSync(ZenWidgetMutationRecorded);

export class ZenProjection implements Projection {
  readonly name = "zen";
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec(`
      DELETE FROM zen_space_projection;
    `);
  }

  apply(connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    const payload =
      event.eventName === ZEN_SPACE_SNAPSHOT_RECORDED_V1
        ? decodeSnapshot(migrateLegacyTimerSnapshots(event.payload))
        : event.eventName === ZEN_SPACE_SNAPSHOT_RECORDED_V2
          ? decodeSnapshot(event.payload)
          : event.eventName === ZEN_WIDGET_MUTATION_RECORDED
            ? decodeWidgetMutation(event.payload)
            : undefined;
    if (payload === undefined) return;

    const spaceJson = JSON.stringify(payload.space);

    connection
      .prepare(
        `
      INSERT OR REPLACE INTO zen_space_projection (
        space_id,
        schema_version,
        space_json,
        aggregate_version,
        last_sequence
      ) VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        payload.spaceId,
        ZEN_PROJECTION_SCHEMA_VERSION,
        spaceJson,
        event.aggregateVersion,
        event.globalSequence,
      );
  }

  createTable(connection: SqliteConnection): void {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS zen_space_projection (
        space_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT ${ZEN_PROJECTION_SCHEMA_VERSION},
        space_json TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL DEFAULT 0,
        last_sequence INTEGER NOT NULL DEFAULT 0
      )
    `);
  }
}

function migrateLegacyTimerSnapshots(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const snapshot = payload as Record<string, unknown>;
  if (
    typeof snapshot.space !== "object" ||
    snapshot.space === null ||
    Array.isArray(snapshot.space)
  ) {
    return payload;
  }
  const space = snapshot.space as Record<string, unknown>;
  if (!Array.isArray(space.elements)) return payload;
  return {
    ...snapshot,
    space: {
      ...space,
      elements: space.elements.map((element) => {
        if (typeof element !== "object" || element === null || Array.isArray(element)) {
          return element;
        }
        const timer = element as Record<string, unknown>;
        if (timer.kind !== "timer" || typeof timer.running !== "boolean" || "status" in timer) {
          return element;
        }
        const { running, ...rest } = timer;
        const remainingMs = typeof timer.remainingMs === "number" ? timer.remainingMs : 0;
        const durationMs = typeof timer.durationMs === "number" ? timer.durationMs : 0;
        return {
          ...rest,
          status:
            remainingMs === 0
              ? "completed"
              : !running && remainingMs === durationMs
                ? "idle"
                : "paused",
          startedAt: null,
          deadlineAt: null,
          clockSessionId: null,
          monotonicStartedMs: null,
        };
      }),
    },
  };
}

export function loadZenSpace(connection: SqliteConnection, spaceId: ZenSpaceId): ZenSpace | null {
  const row = connection
    .prepare(`SELECT * FROM zen_space_projection WHERE space_id = ?`)
    .get(spaceId) as ZenSpaceProjectionRow | undefined;

  if (!row) return null;
  return decodePersistedZenSpace(JSON.parse(row.space_json));
}

export function loadZenSpaceByWindowId(
  connection: SqliteConnection,
  windowId: string,
): ZenSpace | null {
  const row = connection
    .prepare(
      `SELECT * FROM zen_space_projection WHERE space_id = (
      SELECT space_id FROM zen_space_projection
      WHERE space_json LIKE ?
      LIMIT 1
    )`,
    )
    .get(`%"windowId":"${windowId}"%`) as ZenSpaceProjectionRow | undefined;

  if (!row) return null;
  return decodePersistedZenSpace(JSON.parse(row.space_json));
}

export function loadZenSpaces(connection: SqliteConnection): ReadonlyArray<ZenSpace> {
  const rows = connection
    .prepare(`SELECT space_json FROM zen_space_projection ORDER BY space_id`)
    .all() as ReadonlyArray<Pick<ZenSpaceProjectionRow, "space_json">>;
  return rows.map((row) => decodePersistedZenSpace(JSON.parse(row.space_json)));
}
