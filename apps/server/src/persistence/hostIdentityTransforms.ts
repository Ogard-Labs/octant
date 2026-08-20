import { AUTOMATION_EVENT_NAMES } from "@octant/contracts/automation";
import { REMOTE_ACCESS_EVENT_NAMES } from "@octant/contracts/remote-access";
import type { EventRegistry } from "./eventRegistry";
import { HostIdentityMigrationRegistry } from "./hostIdentityMigration";

type JsonRecord = Record<string, unknown>;

export function createRuntimeHostIdentityMigrationRegistry(
  events: EventRegistry,
): HostIdentityMigrationRegistry {
  const registry = new HostIdentityMigrationRegistry()
    .registerEnvelopeOnly(events.registrations())
    .register("workspace.layout-replaced", 1, migrateWorkspaceLayoutHostIdentity)
    .register("zen.space-snapshot-recorded@1", 1, migrateZenHostIdentity)
    .register("zen.space-snapshot-recorded@2", 1, migrateZenHostIdentity)
    .register("zen.widget-mutation-recorded@1", 1, migrateZenHostIdentity)
    .register("validation.plan-created@1", 1, migrateValidationPlanHostIdentity)
    .register("validation.evidence-recorded@1", 1, migrateValidationEvidenceHostIdentity)
    .register("validation.report-completed@1", 1, migrateValidationReportHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.hostIdentityInitialized, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceRegistered, 1, migrateDeviceHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceKeyRotated, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceRevoked, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.deviceCredentialExpired, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.hostKeyRotated, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.sessionInvalidated, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.commandReceiptRecorded, 1, migrateDirectHostIdentity)
    .register(REMOTE_ACCESS_EVENT_NAMES.securityAuditRecorded, 1, migrateAuditHostIdentity);
  for (const eventName of AUTOMATION_EVENT_NAMES) {
    registry.register(eventName, 1, migrateNestedHostIdentity);
  }
  return registry;
}

/**
 * Automation payloads carry `hostId` on definitions, bindings, execution
 * profiles, snapshots, and remote principals at several nesting depths, so
 * migrate every matching `hostId` field recursively.
 */
function migrateNestedHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => migrateNestedHostIdentity(item, fromHostId, toHostId));
  }
  const record = asRecord(payload);
  if (record === undefined) return payload;
  return Object.fromEntries(
    Object.entries(record).map(([field, value]) => [
      field,
      field === "hostId" && value === fromHostId
        ? toHostId
        : migrateNestedHostIdentity(value, fromHostId, toHostId),
    ]),
  );
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function replaceField(
  record: JsonRecord,
  field: string,
  fromHostId: string,
  toHostId: string,
): JsonRecord {
  return record[field] === fromHostId ? { ...record, [field]: toHostId } : record;
}

function migrateDirectHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(payload);
  return record === undefined ? payload : replaceField(record, "hostId", fromHostId, toHostId);
}

function migrateWorkspaceLayoutHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(payload);
  const workspace = asRecord(record?.workspace);
  const contexts = asRecord(workspace?.contextByMode);
  const layouts = asRecord(workspace?.layouts);
  if (
    record === undefined ||
    workspace === undefined ||
    contexts === undefined ||
    layouts === undefined
  ) {
    return payload;
  }

  const contextByMode = Object.fromEntries(
    Object.entries(contexts).map(([mode, value]) => {
      const context = asRecord(value);
      return [
        mode,
        context === undefined ? value : replaceField(context, "host", fromHostId, toHostId),
      ];
    }),
  );
  const migratedLayouts = Object.fromEntries(
    Object.entries(layouts).map(([mode, value]) => [
      mode,
      migrateWorkspaceLayoutNode(value, fromHostId, toHostId),
    ]),
  );
  return {
    ...record,
    workspace: { ...workspace, contextByMode, layouts: migratedLayouts },
  };
}

function migrateWorkspaceLayoutNode(value: unknown, fromHostId: string, toHostId: string): unknown {
  const node = asRecord(value);
  if (node?.kind === "split") {
    return {
      ...node,
      first: migrateWorkspaceLayoutNode(node.first, fromHostId, toHostId),
      second: migrateWorkspaceLayoutNode(node.second, fromHostId, toHostId),
    };
  }
  if (node?.kind !== "group" || !Array.isArray(node.tabs)) return value;
  return {
    ...node,
    tabs: node.tabs.map((tab) => {
      const record = asRecord(tab);
      return record?.kind === "preview"
        ? replaceField(record, "hostId", fromHostId, toHostId)
        : tab;
    }),
  };
}

function migrateZenHostIdentity(payload: unknown, fromHostId: string, toHostId: string): unknown {
  const record = asRecord(payload);
  const space = asRecord(record?.space);
  if (record === undefined || space === undefined || !Array.isArray(space.elements)) return payload;
  return {
    ...record,
    space: {
      ...space,
      elements: space.elements.map((element) => {
        const item = asRecord(element);
        const context = asRecord(item?.sourceContext);
        if (item?.kind !== "thread" || context === undefined) return element;
        return {
          ...item,
          sourceContext: replaceField(context, "hostId", fromHostId, toHostId),
        };
      }),
    },
  };
}

function migrateAuthorityHostIdentity(
  value: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(value);
  const authority = asRecord(record?.authority);
  return record === undefined || authority === undefined
    ? value
    : { ...record, authority: replaceField(authority, "hostId", fromHostId, toHostId) };
}

function migrateValidationPlanHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(payload);
  return record === undefined
    ? payload
    : { ...record, plan: migrateAuthorityHostIdentity(record.plan, fromHostId, toHostId) };
}

function migrateValidationEvidenceHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(payload);
  return record === undefined
    ? payload
    : { ...record, evidence: migrateAuthorityHostIdentity(record.evidence, fromHostId, toHostId) };
}

function migrateValidationReportHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(payload);
  const report = asRecord(record?.report);
  if (record === undefined || report === undefined) return payload;
  const migrated = migrateAuthorityHostIdentity(report, fromHostId, toHostId) as JsonRecord;
  return {
    ...record,
    report: {
      ...migrated,
      evidence: Array.isArray(report.evidence)
        ? report.evidence.map((evidence) =>
            migrateAuthorityHostIdentity(evidence, fromHostId, toHostId),
          )
        : report.evidence,
    },
  };
}

function migrateDeviceHostIdentity(
  payload: unknown,
  fromHostId: string,
  toHostId: string,
): unknown {
  const record = asRecord(payload);
  const device = asRecord(record?.device);
  return record === undefined || device === undefined
    ? payload
    : { ...record, device: replaceField(device, "hostId", fromHostId, toHostId) };
}

function migrateAuditHostIdentity(payload: unknown, fromHostId: string, toHostId: string): unknown {
  const record = asRecord(payload);
  const audit = asRecord(record?.record);
  return record === undefined || audit === undefined
    ? payload
    : { ...record, record: replaceField(audit, "hostId", fromHostId, toHostId) };
}
