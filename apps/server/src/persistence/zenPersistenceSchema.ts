import { ZenSpace } from "@octant/contracts/zen";
import { Schema } from "effect";

export const ZEN_PROJECTION_SCHEMA_VERSION = 1;

export interface ZenSpaceProjectionRow {
  readonly schema_version: number;
  readonly space_id: string;
  readonly space_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

const PersistedZenSpace = Schema.transform(Schema.Unknown, ZenSpace, {
  strict: false,
  decode: (raw) => {
    if (typeof raw !== "object" || raw === null) return raw;
    const obj = raw as Record<string, unknown>;
    // Ensure elements array exists for legacy data
    if (!Array.isArray(obj.elements)) {
      obj.elements = [];
    }
    // Default durable presentation state for pre-persistence data
    if (typeof obj.active !== "boolean") {
      obj.active = false;
    }
    if (typeof obj.barCollapsed !== "boolean") {
      obj.barCollapsed = false;
    }
    return obj;
  },
  encode: (_encoded, space) => space,
});

export const decodePersistedZenSpace = Schema.decodeUnknownSync(PersistedZenSpace);
