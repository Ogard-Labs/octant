import { createHash } from "node:crypto";
import type { EventRegistry } from "./eventRegistry";
import type { SqliteConnection } from "./sqlitePort";

/**
 * Startup decodes every journal row to prove the journal is readable, which
 * cost 0.9 to 1.7 s on 32,000 rows and grows forever. The watermark records the
 * sequence a scan found compatible, so the next start decodes only newer rows.
 *
 * The journal stays authoritative and the watermark is disposable: anything
 * missing, malformed, above the journal head or recorded under a different
 * fingerprint reads as "no watermark", which means a full scan.
 */

/**
 * Serializes a schema AST deterministically, including the source text of every
 * refinement and transformation function, so a persisted schema that changes
 * without a version bump changes the fingerprint. Throws on anything it cannot
 * serialize; the caller reads that as "no fingerprint".
 *
 * A recursive schema (`Schema.suspend`) builds fresh nodes on every thunk call,
 * so identity cannot end the walk. A suspended body whose shallow shape (itself
 * without expanding nested suspends) matches one already being written is the
 * same recursion and is written as a back reference.
 */
function serializeAst(root: unknown): string {
  const active: Array<string> = [];
  const walk = (start: unknown, expandSuspend: boolean): string => {
    const seen = new Map<object, number>();
    const write = (value: unknown, depth: number): string => {
      if (depth > 200) throw new Error("schema too deep to fingerprint");
      switch (typeof value) {
        case "string":
        case "boolean":
          return JSON.stringify(value);
        case "number":
        case "bigint":
          return `${typeof value}:${String(value)}`;
        case "undefined":
          return "undefined";
        case "symbol":
          return `symbol:${value.description ?? ""}`;
        case "function":
          return `fn:${Function.prototype.toString.call(value)}`;
        default:
      }
      if (value === null) return "null";
      const object = value as object;
      const earlier = seen.get(object);
      if (earlier !== undefined) return `ref:${earlier}`;
      seen.set(object, seen.size);
      if (Array.isArray(object)) {
        return `[${object.map((item) => write(item, depth + 1)).join(",")}]`;
      }
      if (object instanceof Map || object instanceof Set) {
        throw new Error("schema holds a collection that cannot be fingerprinted");
      }
      const record = object as Record<PropertyKey, unknown>;
      const keys = [...Reflect.ownKeys(record)].sort((left, right) =>
        String(left).localeCompare(String(right)),
      );
      const members = keys.map(
        (key) =>
          `${typeof key === "symbol" ? `sym:${key.description ?? ""}` : key}=${write(record[key], depth + 1)}`,
      );
      if (expandSuspend && record["_tag"] === "Suspend" && typeof record["f"] === "function") {
        const body = (record["f"] as () => unknown)();
        const shape = walk(body, false);
        const loop = active.indexOf(shape);
        if (loop >= 0) {
          members.push(`body=cycle:${loop}`);
        } else {
          active.push(shape);
          members.push(`body=${write(body, depth + 1)}`);
          active.pop();
        }
      }
      return `{${members.join(",")}}`;
    };
    return write(start, 0);
  };
  return walk(root, true);
}

/**
 * What a verification depended on: how every registered event decodes (current
 * and persisted schema, not only name and version) plus the schema head.
 * Returns undefined when a schema cannot be serialized, which means a full scan.
 */
export function journalVerificationFingerprint(
  registry: EventRegistry,
  connection: SqliteConnection,
): string | undefined {
  try {
    const migrationHead = connection
      .prepare("SELECT coalesce(max(version), 0) AS value FROM schema_migrations")
      .get() as { readonly value: number };
    const hash = createHash("sha256");
    hash.update(`migrations:${migrationHead.value}\n`);
    for (const source of registry.schemaSources()) {
      hash.update(
        `${source.eventName}@${source.eventVersion}|${serializeAst(source.current.ast)}|${serializeAst(source.persisted.ast)}\n`,
      );
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/** The sequence startup may skip, or 0 when the whole journal must be scanned. */
export function readJournalWatermark(
  connection: SqliteConnection,
  fingerprint: string,
  headSequence: number,
): number {
  try {
    const row = connection
      .prepare("SELECT verified_through, fingerprint FROM journal_verification_watermark")
      .get() as { readonly verified_through: unknown; readonly fingerprint: unknown } | undefined;
    if (row === undefined || row.fingerprint !== fingerprint) return 0;
    const through = row.verified_through;
    if (typeof through !== "number" || !Number.isSafeInteger(through)) return 0;
    return through > 0 && through <= headSequence ? through : 0;
  } catch {
    return 0;
  }
}

export function recordJournalWatermark(
  connection: SqliteConnection,
  fingerprint: string,
  verifiedThrough: number,
  verifiedAt: string,
): void {
  connection
    .prepare(`
      INSERT INTO journal_verification_watermark (singleton, verified_through, fingerprint, verified_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT (singleton) DO UPDATE SET
        verified_through = excluded.verified_through,
        fingerprint = excluded.fingerprint,
        verified_at = excluded.verified_at
    `)
    .run(verifiedThrough, fingerprint, verifiedAt);
}

export function clearJournalWatermark(connection: SqliteConnection): void {
  connection.prepare("DELETE FROM journal_verification_watermark").run();
}
