import type { ProviderDriverKind } from "@octant/contracts";
import type { ProviderSessionOwnership } from "@octant/provider-sdk/driver";
import type { SqliteConnection } from "../persistence/sqlitePort";

const SCAN_PAGE_ROWS = 1_000;
/** Cursors nest no deeper than a Work thread's adopted session inside its update. */
const MAX_DEPTH = 8;
/** Driver kinds are short identifiers; anything else names no cursor to look for. */
const DRIVER_KIND = /^[a-z0-9][a-z0-9-]{0,63}$/u;

interface KindHolds {
  lastSequence: number;
  readonly sessions: Set<string>;
}

/**
 * The runtime sessions an Octant thread holds, read from the host's journal,
 * for any driver kind (the provider SDK's `ProviderSessionOwnership`).
 *
 * Every session an Octant thread starts, takes up or forks is journaled with
 * its resume cursor (`driverKind`, the runtime's session id as its value): a
 * Code operation's `provider-session-ready`, a Work turn's or Work thread's
 * record, a Chat attempt. Any event naming such a cursor counts, so a session
 * is held from the moment the host records it, a thread's adoption included,
 * and the record is the journal itself rather than a copy that could drift
 * from it. A session is held for every instance of its kind: instances of one
 * runtime may share its session store (two OpenCode accounts keep the
 * person's one data folder), so a session one account's thread holds is not
 * another account's to take up.
 *
 * The journal is read once per kind and then from where the last read
 * stopped. A purge removes events, so a session a purged thread held stays
 * held here until the host restarts: refusing to offer it a little longer is
 * the safe way round.
 */
export class JournalProviderSessionOwnership implements ProviderSessionOwnership {
  readonly #connection: SqliteConnection;
  readonly #kinds = new Map<string, KindHolds>();

  constructor(connection: SqliteConnection) {
    this.#connection = connection;
  }

  held(driverKind: ProviderDriverKind): ReadonlySet<string> {
    const kind = String(driverKind);
    if (!DRIVER_KIND.test(kind)) return new Set();
    const holds = this.#kinds.get(kind) ?? { lastSequence: 0, sessions: new Set<string>() };
    this.#kinds.set(kind, holds);
    this.#catchUp(kind, holds);
    return new Set(holds.sessions);
  }

  /** Reads every event after the last read, up to the journal's head when the read began. */
  #catchUp(kind: string, holds: KindHolds): void {
    const head = (
      this.#connection.prepare(`SELECT MAX(global_sequence) AS head FROM event_journal`).get() as
        | { readonly head: number | null }
        | undefined
    )?.head;
    if (head === undefined || head === null || head <= holds.lastSequence) return;
    const marker = `"driverKind":${JSON.stringify(kind)}`;
    let after = holds.lastSequence;
    for (;;) {
      const rows = this.#connection
        .prepare(
          `SELECT global_sequence, payload_json
           FROM event_journal
           WHERE global_sequence > ? AND global_sequence <= ?
             AND instr(payload_json, ?) > 0
           ORDER BY global_sequence ASC
           LIMIT ?`,
        )
        .all(after, head, marker, SCAN_PAGE_ROWS) as ReadonlyArray<{
        readonly global_sequence: number;
        readonly payload_json: string;
      }>;
      for (const row of rows) {
        after = row.global_sequence;
        try {
          collect(JSON.parse(row.payload_json), kind, holds.sessions, 0);
        } catch {
          // An event that does not parse names no cursor Octant could resume.
        }
      }
      if (rows.length < SCAN_PAGE_ROWS) break;
    }
    holds.lastSequence = head;
  }
}

function collect(value: unknown, kind: string, sessions: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, kind, sessions, depth + 1);
    return;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.driverKind === kind && typeof record.value === "string") {
    sessions.add(record.value);
    return;
  }
  for (const child of Object.values(record)) collect(child, kind, sessions, depth + 1);
}
