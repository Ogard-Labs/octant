import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ReplayCursor, type EventEnvelope } from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { threadNotificationFactOf } from "../remote/threadNotificationDeliveryService";

const SCAN_LIMIT = 128;
const decodeReplay = Schema.decodeUnknownSync(ReplayCursor);
const MAX_REPLAY_ROWS = 50_000;
const MAX_AGE_SCAN = 1_024;
const CURSOR_IV_BYTES = 12;
const CURSOR_TAG_BYTES = 16;

export const AGENT_EVENTS_EXTENSION = "io.modelcontextprotocol/events";
export const AGENT_EVENTS_VERSION = "2026-07-28";

const eventTypes = {
  "thread.turn_settled": {
    description: "An Octant thread's turn completed or failed.",
    properties: { turnId: { type: "string" }, status: { enum: ["completed", "failed"] } },
    required: ["turnId", "status"],
  },
  "thread.input_required": {
    description: "A question or approval was requested in an Octant thread.",
    properties: { requestId: { type: "string" }, kind: { enum: ["question", "approval"] } },
    required: ["requestId", "kind"],
  },
} as const;

export type MilestoneName = keyof typeof eventTypes;
export type JsonObject = Readonly<Record<string, unknown>>;
export type RpcId = number | string;

export interface MilestoneFilter {
  readonly grantId: string;
  readonly name: MilestoneName;
  readonly threadId: string;
}

export interface Milestone {
  readonly eventId: string;
  readonly name: MilestoneName;
  readonly timestamp: string;
  readonly data: JsonObject;
}

export function isMilestoneName(name: unknown): name is MilestoneName {
  return typeof name === "string" && Object.hasOwn(eventTypes, name);
}

export function milestoneCatalog(webhooks: boolean): ReadonlyArray<JsonObject> {
  return Object.entries(eventTypes).map(([name, type]) => ({
    name,
    description: type.description,
    delivery: webhooks ? ["poll", "push", "webhook"] : ["poll", "push"],
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["threadId"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: { threadId: { type: "string" }, ...type.properties },
      required: ["threadId", ...type.required],
      additionalProperties: false,
    },
  }));
}

/** Cursors survive a host restart without exposing the journal's global sequence. */
export function milestoneCursorKey(path: string): () => Buffer {
  let key: Buffer | undefined;
  return () => {
    if (key !== undefined) return key;
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const bytes = readFileSync(path);
    if (bytes.length !== 32) throw new Error("Invalid agent event cursor key");
    key = bytes;
    return key;
  };
}

export class AgentMilestoneEvents {
  constructor(
    private readonly journal: Pick<Journal, "headSequence" | "replay"> & {
      readonly subscribeCommitted: (wake: () => void) => () => void;
    },
    private readonly key: () => Buffer,
    private readonly clock: () => number = Date.now,
  ) {}

  position(filter: MilestoneFilter, cursor: string | null, maxAgeMs?: number) {
    const head = this.journal.headSequence();
    if (cursor === null) return { sequence: head, truncated: false };
    const sequence = this.#readCursor(filter, cursor);
    if (sequence === undefined || sequence > head || head - sequence > MAX_REPLAY_ROWS) {
      return { sequence: head, truncated: true };
    }
    if (maxAgeMs === undefined || sequence === head) return { sequence, truncated: false };
    const cutoff = this.clock() - maxAgeMs;
    let seek = sequence;
    while (seek < head && seek - sequence < MAX_AGE_SCAN) {
      const rows = this.journal.replay(decodeReplay({ afterSequence: seek, limit: SCAN_LIMIT }));
      if (rows.length === 0) return { sequence: head, truncated: true };
      for (const row of rows) {
        if (row.globalSequence > head || Date.parse(row.occurredAt) >= cutoff) {
          return { sequence: seek, truncated: seek !== sequence };
        }
        seek = row.globalSequence;
      }
    }
    return { sequence: head, truncated: true };
  }

  cursor(filter: MilestoneFilter, sequence: number): string {
    const iv = randomBytes(CURSOR_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([filter.grantId, filter.name, filter.threadId])));
    const position = Buffer.alloc(8);
    position.writeBigUInt64BE(BigInt(sequence));
    const ciphertext = Buffer.concat([cipher.update(position), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  #readCursor(filter: MilestoneFilter, cursor: string): number | undefined {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length !== CURSOR_IV_BYTES + CURSOR_TAG_BYTES + 8) return undefined;
    const key = this.key();
    try {
      const tagEnd = CURSOR_IV_BYTES + CURSOR_TAG_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, CURSOR_IV_BYTES));
      decipher.setAuthTag(bytes.subarray(CURSOR_IV_BYTES, tagEnd));
      decipher.setAAD(Buffer.from(JSON.stringify([filter.grantId, filter.name, filter.threadId])));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(tagEnd)), decipher.final()]);
      const sequence = Number(plaintext.readBigUInt64BE());
      return Number.isSafeInteger(sequence) ? sequence : undefined;
    } catch {
      return undefined;
    }
  }

  /** Bounded work per call, including when unrelated threads fill the journal. */
  batch(filter: MilestoneFilter, after: number, maxEvents: number) {
    const head = this.journal.headSequence();
    if (head < after || head - after > MAX_REPLAY_ROWS) {
      return { entries: [], sequence: head, hasMore: false, truncated: true };
    }
    const entries: Array<{ readonly event: Milestone; readonly sequence: number }> = [];
    let sequence = after;
    for (const row of this.journal.replay(
      decodeReplay({ afterSequence: after, limit: SCAN_LIMIT }),
    )) {
      sequence = row.globalSequence;
      const event = milestoneOf(filter, row);
      if (event === undefined) continue;
      entries.push({ event, sequence });
      if (entries.length >= maxEvents) break;
    }
    if (sequence === after && sequence < head) {
      return { entries, sequence: head, hasMore: false, truncated: true };
    }
    return { entries, sequence, hasMore: sequence < head, truncated: false };
  }

  onCommit(wake: () => void): () => void {
    return this.journal.subscribeCommitted(wake);
  }
}

function milestoneOf(filter: MilestoneFilter, row: EventEnvelope): Milestone | undefined {
  const fact = threadNotificationFactOf(row);
  if (fact?.threadId !== filter.threadId) return undefined;
  const data =
    filter.name === "thread.input_required"
      ? fact.inputKind === undefined
        ? undefined
        : { requestId: fact.runId, kind: fact.inputKind }
      : fact.kind === "completion" || fact.kind === "failure"
        ? { turnId: fact.runId, status: fact.kind === "completion" ? "completed" : "failed" }
        : undefined;
  if (data === undefined) return undefined;
  // Providers can repeat the same settled state or request across journal writes.
  const eventId =
    "evt_" +
    createHash("sha256")
      .update(JSON.stringify([filter.name, fact.threadId, fact.runId, data]))
      .digest("base64url");
  return {
    eventId,
    name: filter.name,
    timestamp: row.occurredAt,
    data: { threadId: fact.threadId, ...data },
  };
}
