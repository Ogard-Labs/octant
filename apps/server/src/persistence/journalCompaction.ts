import type { SqliteConnection } from "./sqlitePort";

/**
 * Startup compaction of superseded `code.checkout-observed@1` events, per
 * decision record 0039.
 *
 * A reconnect loop once journaled an observation for every poll of an unchanged
 * worktree, growing one aggregate to ~21k payload-identical events. The write
 * side now refuses such repeats; this removes the ones already journaled. Only
 * an observation whose immediate successor in the same `code-checkout`
 * aggregate observes the identical state (same payload except
 * `checkout.observedAt`, same host and actor) is removed, so the last
 * observation of every run — the state each projection already serves — and
 * every transition survive.
 *
 * Removed rows are deleted and the survivors' `aggregate_version` is renumbered
 * contiguously from 1 in the same transaction, because the store verifier
 * treats a per-aggregate version gap as corruption. `aggregate_heads` and
 * `code_checkout_projection` move to the renumbered head atomically with the
 * journal. Global sequences are never rewritten: a superseded row always
 * precedes a retained row of the same aggregate, so the journal head and every
 * projection checkpoint stay valid.
 */
export interface CheckoutObservationCompactionReport {
  readonly checkoutsCompacted: number;
  readonly eventsRemoved: number;
}

const OBSERVED_EVENT = "code.checkout-observed@1";
const CHECKOUT_AGGREGATE = "code-checkout";

interface CheckoutEventRow {
  readonly global_sequence: number;
  readonly aggregate_version: number;
  readonly event_id: string;
  readonly event_name: string;
  readonly event_version: number;
  readonly host_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly actor_json: string | null;
  readonly payload_json: string;
}

export function compactSupersededCheckoutObservations(
  connection: SqliteConnection,
): CheckoutObservationCompactionReport {
  return connection.transaction((): CheckoutObservationCompactionReport => {
    const candidates = connection
      .prepare(`
        SELECT aggregate_id FROM event_journal
        WHERE aggregate_type = ? AND event_name = ?
        GROUP BY aggregate_id
        HAVING count(*) > 1
        ORDER BY aggregate_id
      `)
      .all(CHECKOUT_AGGREGATE, OBSERVED_EVENT) as ReadonlyArray<{
      readonly aggregate_id: string;
    }>;
    if (candidates.length === 0) return { checkoutsCompacted: 0, eventsRemoved: 0 };

    // An event named as another event's cause is evidence some consumer tied
    // work to that exact observation; doubt retains it. One scan covers every
    // aggregate because causation may cross aggregates.
    const referencedAsCause = new Set(
      (
        connection
          .prepare(
            "SELECT DISTINCT causation_id AS cause FROM event_journal WHERE causation_id IS NOT NULL",
          )
          .all() as ReadonlyArray<{ readonly cause: string }>
      ).map((row) => row.cause),
    );

    let checkoutsCompacted = 0;
    let eventsRemoved = 0;
    for (const candidate of candidates) {
      const removed = compactAggregate(connection, candidate.aggregate_id, referencedAsCause);
      if (removed > 0) {
        checkoutsCompacted += 1;
        eventsRemoved += removed;
      }
    }
    return { checkoutsCompacted, eventsRemoved };
  })();
}

function compactAggregate(
  connection: SqliteConnection,
  aggregateId: string,
  referencedAsCause: ReadonlySet<string>,
): number {
  const rows = connection
    .prepare(`
      SELECT global_sequence, aggregate_version, event_id, event_name, event_version,
             host_id, actor_kind, actor_id, actor_json, payload_json
      FROM event_journal
      WHERE aggregate_type = ? AND aggregate_id = ?
      ORDER BY aggregate_version ASC
    `)
    .all(CHECKOUT_AGGREGATE, aggregateId) as ReadonlyArray<CheckoutEventRow>;
  if (rows.length < 2) return 0;

  // Fail closed on any aggregate whose stored shape disagrees with what a
  // healthy journal guarantees. Compaction never repairs; it only removes
  // provably redundant rows from streams that are already consistent.
  if (!streamIsContiguous(rows)) return 0;
  if (aggregateHasQuarantine(connection, aggregateId)) return 0;
  const tail = rows[rows.length - 1];
  if (tail === undefined) return 0;
  if (!headAgreesWithTail(connection, aggregateId, tail)) return 0;
  const projectionVersion = checkoutProjectionVersion(connection, aggregateId);
  if (projectionVersion !== undefined && projectionVersion !== tail.aggregate_version) return 0;

  const redundant: Array<CheckoutEventRow> = [];
  for (let index = 0; index < rows.length - 1; index += 1) {
    const event = rows[index];
    const successor = rows[index + 1];
    if (event === undefined || successor === undefined) continue;
    if (referencedAsCause.has(event.event_id)) continue;
    if (observesIdenticalState(event, successor)) redundant.push(event);
  }
  if (redundant.length === 0) return 0;

  const deleteEvent = connection.prepare("DELETE FROM event_journal WHERE global_sequence = ?");
  for (const event of redundant) deleteEvent.run(event.global_sequence);

  // Renumber ascending: every new version is at most the row's old version and
  // any smaller number is already held by an earlier survivor that has moved,
  // so the UNIQUE(aggregate_type, aggregate_id, aggregate_version) constraint
  // never sees a transient collision.
  const removedSequences = new Set(redundant.map((event) => event.global_sequence));
  const survivors = rows.filter((event) => !removedSequences.has(event.global_sequence));
  const renumber = connection.prepare(
    "UPDATE event_journal SET aggregate_version = ? WHERE global_sequence = ?",
  );
  survivors.forEach((event, index) => {
    const version = index + 1;
    if (event.aggregate_version !== version) renumber.run(version, event.global_sequence);
  });

  const headVersion = survivors.length;
  connection
    .prepare(
      "UPDATE aggregate_heads SET aggregate_version = ? WHERE aggregate_type = ? AND aggregate_id = ?",
    )
    .run(headVersion, CHECKOUT_AGGREGATE, aggregateId);
  if (projectionVersion !== undefined) {
    connection
      .prepare("UPDATE code_checkout_projection SET aggregate_version = ? WHERE checkout_id = ?")
      .run(headVersion, aggregateId);
  }
  return redundant.length;
}

function streamIsContiguous(rows: ReadonlyArray<CheckoutEventRow>): boolean {
  let previousSequence = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) return false;
    if (row.aggregate_version !== index + 1) return false;
    if (row.global_sequence <= previousSequence) return false;
    previousSequence = row.global_sequence;
  }
  return true;
}

function aggregateHasQuarantine(connection: SqliteConnection, aggregateId: string): boolean {
  return (
    connection
      .prepare(`
        SELECT 1 AS present
        FROM event_quarantine
        JOIN event_journal ON event_journal.global_sequence = event_quarantine.global_sequence
        WHERE event_journal.aggregate_type = ? AND event_journal.aggregate_id = ?
        LIMIT 1
      `)
      .get(CHECKOUT_AGGREGATE, aggregateId) !== undefined
  );
}

function headAgreesWithTail(
  connection: SqliteConnection,
  aggregateId: string,
  tail: CheckoutEventRow,
): boolean {
  const head = connection
    .prepare(
      "SELECT aggregate_version, last_sequence FROM aggregate_heads WHERE aggregate_type = ? AND aggregate_id = ?",
    )
    .get(CHECKOUT_AGGREGATE, aggregateId) as
    | { readonly aggregate_version: number; readonly last_sequence: number }
    | undefined;
  return (
    head !== undefined &&
    head.aggregate_version === tail.aggregate_version &&
    head.last_sequence === tail.global_sequence
  );
}

function checkoutProjectionVersion(
  connection: SqliteConnection,
  aggregateId: string,
): number | undefined {
  const row = connection
    .prepare("SELECT aggregate_version FROM code_checkout_projection WHERE checkout_id = ?")
    .get(aggregateId) as { readonly aggregate_version: number } | undefined;
  return row?.aggregate_version;
}

function observesIdenticalState(event: CheckoutEventRow, successor: CheckoutEventRow): boolean {
  if (event.event_name !== OBSERVED_EVENT || successor.event_name !== OBSERVED_EVENT) return false;
  if (event.event_version !== 1 || successor.event_version !== 1) return false;
  if (event.host_id !== successor.host_id) return false;
  if (event.actor_kind !== successor.actor_kind) return false;
  if (event.actor_id !== successor.actor_id) return false;
  if (!actorJsonEqual(event.actor_json, successor.actor_json)) return false;
  const payload = observationWithoutTimestamp(event.payload_json);
  const successorPayload = observationWithoutTimestamp(successor.payload_json);
  if (payload === undefined || successorPayload === undefined) return false;
  return jsonValueEqual(payload, successorPayload);
}

function actorJsonEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const parsedA = parseJson(a);
  const parsedB = parseJson(b);
  if (parsedA === undefined || parsedB === undefined) return false;
  return jsonValueEqual(parsedA.value, parsedB.value);
}

/**
 * The observation payload with `checkout.observedAt` removed — the only field
 * a repeated poll of an unchanged worktree legitimately varies. Any payload
 * that is not the expected `checkout-observed` shape is unknown territory and
 * reads as never-identical.
 */
function observationWithoutTimestamp(payloadJson: string): unknown {
  const parsed = parseJson(payloadJson);
  if (parsed === undefined) return undefined;
  const payload = parsed.value;
  if (!isPlainRecord(payload) || payload["kind"] !== "checkout-observed") return undefined;
  const checkout = payload["checkout"];
  if (!isPlainRecord(checkout) || typeof checkout["observedAt"] !== "string") return undefined;
  const { observedAt: _observedAt, ...checkoutWithoutTimestamp } = checkout;
  return { ...payload, checkout: checkoutWithoutTimestamp };
}

function parseJson(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality over parsed JSON. Key order in stored `payload_json`
 * depends on the serializer version that wrote the row, so string comparison
 * of two honestly identical payloads could miss.
 */
function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => jsonValueEqual(entry, b[index]))
    );
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => Object.hasOwn(b, key) && jsonValueEqual(a[key], b[key]))
  );
}
