import {
  ACCESS_ACTIVITY_LIMIT,
  CHANGE_NOTICE_AGGREGATE_TYPE,
  type AccessActivityEntry,
  type AccessChangeActor,
  type ChangeNotice,
  type ChangeNoticeActor,
} from "@octant/contracts/access-activity";
import { decodeGuardrailLevelLowered } from "@octant/contracts/guardrail-lowering";
import {
  decodeProviderKeyJournalRecord,
  PROVIDER_KEY_AGGREGATE_TYPE,
  type ProviderKeyJournalRecord,
} from "@octant/contracts/provider-key-journal";
import {
  DEFAULT_DEVICE_ACCESS_LEVEL,
  isDeviceAccessLevel,
  REMOTE_ACCESS_EVENT_NAMES,
} from "@octant/contracts/remote-access";
import { threadAccessRaised } from "@octant/domain/guardrail-policy";
import { readAgentGrants } from "../persistence/agentAccessProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";

/**
 * Access activity and change notices are read from the journal itself, the
 * authority for who did what: no projection holds them, so a rebuild cannot
 * lose a dismissal or invent a notice. Each read is bounded to the newest
 * events of a few aggregate types, which the journal indexes by type.
 */

interface JournalRow {
  readonly global_sequence: number;
  readonly event_id: string;
  readonly event_name: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}

const JOURNAL_COLUMNS =
  "global_sequence, event_id, event_name, actor_kind, actor_id, occurred_at, payload_json";
/** How far back the notice reads look; a notice older than this many changes is not shown. */
const NOTICE_LOOKBACK = 500;
const MAX_NOTICES = 50;
const UNNAMED_DEVICE = "Unnamed device";

/** Device added (approved), removed (revoked or expired), and re-levelled, newest first. */
export function readAccessActivity(
  connection: SqliteConnection,
  limit = ACCESS_ACTIVITY_LIMIT,
): ReadonlyArray<AccessActivityEntry> {
  const names = REMOTE_ACCESS_EVENT_NAMES;
  const rows = connection
    .prepare(
      `SELECT ${JOURNAL_COLUMNS} FROM event_journal
       WHERE aggregate_type IN ('remote-device', 'remote-host')
         AND (event_name IN (?, ?, ?)
           OR (event_name = ? AND json_extract(payload_json, '$.record.eventKind') = 'device-approved'))
       ORDER BY global_sequence DESC LIMIT ?`,
    )
    .all(
      names.deviceRevoked,
      names.deviceCredentialExpired,
      names.deviceAccessLevelChanged,
      names.securityAuditRecorded,
      Math.min(limit, ACCESS_ACTIVITY_LIMIT),
    ) as ReadonlyArray<JournalRow>;
  const actors = actorResolver(connection);
  const entries: AccessActivityEntry[] = [];
  for (const row of rows) {
    const payload = parse(row.payload_json);
    const common = { entryId: row.event_id, at: row.occurred_at };
    if (row.event_name === names.securityAuditRecorded) {
      const record = field(payload, "record");
      const deviceId = stringField(record, "deviceId");
      if (deviceId === undefined) continue;
      const level = field(record, "accessLevel");
      entries.push({
        kind: "added",
        ...common,
        deviceId,
        deviceLabel: actors.deviceLabel(deviceId),
        accessLevel: isDeviceAccessLevel(level) ? level : DEFAULT_DEVICE_ACCESS_LEVEL,
        // A pairing the person approved at a window journals the host's own
        // actor; a device the hub's roster introduced was no person's choice.
        actor: actors.of(
          row,
          field(record, "reasonCode") === "user-approved" ? "local-person" : "host",
        ),
      });
      continue;
    }
    const deviceId = stringField(payload, "deviceId");
    if (deviceId === undefined) continue;
    const deviceLabel = actors.deviceLabel(deviceId);
    if (row.event_name === names.deviceAccessLevelChanged) {
      const previousLevel = field(payload, "previousLevel");
      const accessLevel = field(payload, "accessLevel");
      if (!isDeviceAccessLevel(previousLevel) || !isDeviceAccessLevel(accessLevel)) continue;
      entries.push({
        kind: "relevelled",
        ...common,
        deviceId,
        deviceLabel,
        previousLevel,
        accessLevel,
        actor: actors.of(row, "local-person"),
      });
      continue;
    }
    if (row.event_name === names.deviceCredentialExpired) {
      entries.push({
        kind: "removed",
        ...common,
        deviceId,
        deviceLabel,
        reason: "expired",
        actor: { kind: "host" },
      });
      continue;
    }
    const reason = removalReason(stringField(payload, "reasonCode"));
    entries.push({
      kind: "removed",
      ...common,
      deviceId,
      deviceLabel,
      reason,
      actor:
        reason === "self-revoked"
          ? { kind: "device", deviceId, label: deviceLabel }
          : actors.of(row, reason === "host-key-recovered" ? "host" : "local-person"),
    });
  }
  return entries;
}

/** A change notice with what the host needs to act on it, never sent to a client as is. */
export interface ChangeNoticeRecord {
  readonly notice: ChangeNotice;
  /** The paired device or agent grant session that made the change. */
  readonly actorDeviceId: string;
  readonly dismissed: boolean;
  /** For a key added: the key Undo removes. */
  readonly keyId?: string;
  /** For a key notice: the key was changed again after this change, so Undo is refused. */
  readonly changedSince?: boolean;
}

export interface ChangeNoticeNames {
  readonly threadTitle?: (surface: "code" | "work", threadId: string) => string | undefined;
  readonly providerName?: (instanceId: string) => string | undefined;
}

/**
 * Every change a paired device or an agent grant made that raised a thread's
 * level or added or replaced a provider key, newest first. A change made at a
 * window on this computer is the person at it and raises no notice, and a
 * lowering or a sideways move is never one.
 */
export function readChangeNotices(
  connection: SqliteConnection,
  names: ChangeNoticeNames = {},
): ReadonlyArray<ChangeNoticeRecord> {
  const actors = actorResolver(connection);
  const dismissed = new Set(
    (
      connection
        .prepare(`SELECT DISTINCT aggregate_id FROM event_journal WHERE aggregate_type = ?`)
        .all(CHANGE_NOTICE_AGGREGATE_TYPE) as ReadonlyArray<{ readonly aggregate_id: string }>
    ).map((row) => row.aggregate_id),
  );
  const records: Array<ChangeNoticeRecord & { readonly sequence: number }> = [];

  for (const row of newest(connection, "guardrail-change")) {
    if (row.actor_kind !== "remote-device") continue;
    let change;
    try {
      change = decodeGuardrailLevelLowered(parse(row.payload_json));
    } catch {
      continue;
    }
    if (change.scope !== "thread" || change.threadId === undefined || change.from === undefined)
      continue;
    if (!threadAccessRaised(change.from, change.to)) continue;
    const title = names.threadTitle?.(change.surface, change.threadId);
    records.push({
      sequence: row.global_sequence,
      actorDeviceId: row.actor_id,
      dismissed: dismissed.has(row.event_id),
      notice: {
        kind: "thread-level-raised",
        noticeId: row.event_id,
        at: row.occurred_at,
        actor: actors.noticeActor(row.actor_id),
        surface: change.surface,
        threadId: change.threadId,
        ...(title === undefined || title.length === 0 ? {} : { threadTitle: title.slice(0, 256) }),
        from: change.from,
        to: change.to,
      },
    });
  }

  // Oldest first, so a later change to the same provider is seen after the one it follows.
  const keyRows = [...newest(connection, PROVIDER_KEY_AGGREGATE_TYPE)].reverse();
  const requests = new Map<string, { readonly row: JournalRow; readonly record: Requested }>();
  const stored: Array<{ readonly sequence: number; readonly requestId: string }> = [];
  const lastChange = new Map<string, number>();
  for (const row of keyRows) {
    let record: ProviderKeyJournalRecord;
    try {
      record = decodeProviderKeyJournalRecord(parse(row.payload_json));
    } catch {
      continue;
    }
    if (record.name === "provider-key.change-requested") {
      requests.set(record.requestId, { row, record });
      continue;
    }
    if (record.name !== "provider-key.change-completed") continue;
    lastChange.set(String(record.instanceId), row.global_sequence);
    if (record.outcome === "stored")
      stored.push({ sequence: row.global_sequence, requestId: record.requestId });
  }
  for (const { sequence, requestId } of stored) {
    const request = requests.get(requestId);
    if (request === undefined || request.row.actor_kind !== "remote-device") continue;
    const { record, row } = request;
    if (record.keyChange === undefined) continue;
    const instanceId = String(record.instanceId);
    const providerName = names.providerName?.(instanceId);
    records.push({
      sequence,
      actorDeviceId: row.actor_id,
      dismissed: dismissed.has(row.event_id),
      ...(record.keyChange === "added" && record.keyId !== undefined
        ? { keyId: record.keyId }
        : {}),
      changedSince: (lastChange.get(instanceId) ?? sequence) > sequence,
      notice: {
        kind: record.keyChange === "added" ? "provider-key-added" : "provider-key-replaced",
        noticeId: row.event_id,
        at: row.occurred_at,
        actor: actors.noticeActor(row.actor_id),
        providerInstanceId: instanceId,
        ...(providerName === undefined || providerName.length === 0
          ? {}
          : { providerName: providerName.slice(0, 256) }),
      },
    });
  }

  return records
    .sort((left, right) => right.sequence - left.sequence)
    .map(({ sequence: _sequence, ...record }) => record);
}

/** The notices a viewer sees: not dismissed, and not ones its own device made. */
export function noticesFor(
  records: ReadonlyArray<ChangeNoticeRecord>,
  viewerDeviceId: string | undefined,
): ReadonlyArray<ChangeNoticeRecord> {
  return records
    .filter((record) => !record.dismissed && record.actorDeviceId !== viewerDeviceId)
    .slice(0, MAX_NOTICES);
}

type Requested = Extract<ProviderKeyJournalRecord, { name: "provider-key.change-requested" }>;

function newest(connection: SqliteConnection, aggregateType: string): ReadonlyArray<JournalRow> {
  return connection
    .prepare(
      `SELECT ${JOURNAL_COLUMNS} FROM event_journal WHERE aggregate_type = ?
       ORDER BY global_sequence DESC LIMIT ?`,
    )
    .all(aggregateType, NOTICE_LOOKBACK) as ReadonlyArray<JournalRow>;
}

/**
 * Names an envelope's actor. A host record (`system`) means the person at a
 * window for a change only a person makes, and the host itself otherwise.
 */
function actorResolver(connection: SqliteConnection) {
  const labels = new Map(
    (
      connection
        .prepare("SELECT device_id, device_label FROM remote_device_projection")
        .all() as ReadonlyArray<{ readonly device_id: string; readonly device_label: string }>
    ).map((row) => [row.device_id, row.device_label]),
  );
  let grants: ReadonlyMap<string, { readonly grantId: string; readonly name: string }> | undefined;
  const grantOf = (scopeId: string) => {
    grants ??= new Map(
      readAgentGrants(connection).map((grant) => [
        String(grant.scopeId),
        { grantId: String(grant.grantId), name: grant.name },
      ]),
    );
    return grants.get(scopeId);
  };
  const deviceLabel = (deviceId: string) => labels.get(deviceId) ?? UNNAMED_DEVICE;
  // An agent grant's session acts under the grant's scope id, which no
  // paired device's registration carries.
  const noticeActor = (deviceId: string): ChangeNoticeActor => {
    const grant = labels.has(deviceId) ? undefined : grantOf(deviceId);
    return grant === undefined
      ? { kind: "device", deviceId, label: deviceLabel(deviceId) }
      : { kind: "agent", grantId: grant.grantId, name: grant.name };
  };
  return {
    deviceLabel,
    noticeActor,
    of: (row: JournalRow, system: "local-person" | "host"): AccessChangeActor => {
      switch (row.actor_kind) {
        case "remote-device":
          return noticeActor(row.actor_id);
        case "local-user":
          return { kind: "local-person" };
        case "owner-unlock":
          return { kind: "owner-device" };
        default:
          return { kind: system };
      }
    },
  };
}

function removalReason(
  reasonCode: string | undefined,
): Extract<AccessActivityEntry, { kind: "removed" }>["reason"] {
  if (reasonCode === "other-devices-signed-out") return "signed-out";
  if (reasonCode === "self-revoked") return "self-revoked";
  if (reasonCode === "host-key-recovered") return "host-key-recovered";
  return "revoked";
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === "string" ? found : undefined;
}
