import type { ProviderInstanceId } from "@octant/contracts";
import type { SqliteConnection } from "../persistence/sqlitePort";

const SCAN_PAGE_ROWS = 1_000;
/** Cursors nest no deeper than a Work thread's adopted session inside its update. */
const MAX_DEPTH = 8;

/**
 * The OpenCode sessions an Octant thread holds, read from the host's journal.
 *
 * Every session an Octant thread starts, takes up or forks is journaled with
 * its resume cursor (`driverKind: "opencode"`, the OpenCode session id as its
 * value, and the instance in its binding): a Code operation's
 * `provider-session-ready`, a Work turn's or Work thread's record, a Chat
 * attempt. Any event naming such a cursor counts, so a session is held from
 * the moment the host records it, a thread's adoption included, and the record
 * is the journal itself rather than a copy that could drift from it. A cursor
 * with no binding predates the record of its instance and is held for every
 * instance, on the safe side.
 *
 * The journal is read once and then from where the last read stopped. A purge
 * removes events, so a session a purged thread held stays held here until the
 * host restarts: refusing to offer it a little longer is the safe way round.
 */
export class OpenCodeSessionHolds {
  readonly #connection: SqliteConnection;
  #lastSequence = 0;
  /** OpenCode session id -> the instances whose cursors name it ("" for any). */
  readonly #holds = new Map<string, Set<string>>();

  constructor(connection: SqliteConnection) {
    this.#connection = connection;
  }

  held(instanceId: ProviderInstanceId): ReadonlySet<string> {
    this.#catchUp();
    const held = new Set<string>();
    for (const [sessionId, instances] of this.#holds) {
      if (instances.has("") || instances.has(String(instanceId))) held.add(sessionId);
    }
    return held;
  }

  /** Reads every event after the last read, up to the journal's head when the read began. */
  #catchUp(): void {
    const head = (
      this.#connection.prepare(`SELECT MAX(global_sequence) AS head FROM event_journal`).get() as
        | { readonly head: number | null }
        | undefined
    )?.head;
    if (head === undefined || head === null || head <= this.#lastSequence) return;
    let after = this.#lastSequence;
    for (;;) {
      const rows = this.#connection
        .prepare(
          `SELECT global_sequence, payload_json
           FROM event_journal
           WHERE global_sequence > ? AND global_sequence <= ?
             AND instr(payload_json, '"driverKind":"opencode"') > 0
           ORDER BY global_sequence ASC
           LIMIT ?`,
        )
        .all(after, head, SCAN_PAGE_ROWS) as ReadonlyArray<{
        readonly global_sequence: number;
        readonly payload_json: string;
      }>;
      for (const row of rows) {
        after = row.global_sequence;
        try {
          this.#collect(JSON.parse(row.payload_json), 0);
        } catch {
          // An event that does not parse names no cursor Octant could resume.
        }
      }
      if (rows.length < SCAN_PAGE_ROWS) break;
    }
    this.#lastSequence = head;
  }

  #collect(value: unknown, depth: number): void {
    if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) this.#collect(item, depth + 1);
      return;
    }
    const record = value as Readonly<Record<string, unknown>>;
    if (record.driverKind === "opencode" && typeof record.value === "string") {
      const binding = record.binding;
      const instanceId =
        typeof binding === "object" &&
        binding !== null &&
        "instanceId" in binding &&
        typeof binding.instanceId === "string"
          ? binding.instanceId
          : "";
      const instances = this.#holds.get(record.value) ?? new Set<string>();
      instances.add(instanceId);
      this.#holds.set(record.value, instances);
      return;
    }
    for (const child of Object.values(record)) this.#collect(child, depth + 1);
  }
}
