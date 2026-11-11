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

/** What a verification depended on: which events the registry can decode and the schema head. */
export function journalVerificationFingerprint(
  registry: EventRegistry,
  connection: SqliteConnection,
): string {
  const migrationHead = connection
    .prepare("SELECT coalesce(max(version), 0) AS value FROM schema_migrations")
    .get() as { readonly value: number };
  return createHash("sha256")
    .update(JSON.stringify({ registrations: registry.registrations(), migrationHead }))
    .digest("hex");
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
