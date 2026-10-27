import {
  decodeExtensionLifecycleEvent,
  type ExtensionLifecycleEvent,
  type ExtensionToolGrantRevocationReason,
} from "@octant/contracts/extension-events";
import {
  decodeExtensionPackageManifest,
  type ExtensionActivationState,
  type ExtensionDiagnostic,
  type ExtensionPackageManifest,
  type ExtensionPackageState,
} from "@octant/contracts/extensions";
import { decodeExtensionSnapshot, type ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { EventEnvelope } from "@octant/contracts/events";
import { resolveExtensionActivation } from "@octant/plugin-host/activation";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const EXTENSION_PROJECTION_NAME = "extensions";
export const EXTENSION_LIFECYCLE_EVENT = "extension.lifecycle-recorded@1";
export const EXTENSION_AGGREGATE_TYPE = "extension-package";

export interface ProjectedExtensionVersion {
  readonly manifest: ExtensionPackageManifest;
  readonly verified: boolean;
  readonly quarantined: boolean;
}

export interface ProjectedExtensionPending {
  readonly transactionId: string;
  readonly operation: "install" | "update";
  readonly target: {
    readonly extensionId: string;
    readonly packageId: string;
    readonly version: string;
    readonly digest: string;
  };
}

export interface ProjectedExtensionRecord {
  readonly schemaVersion: 1;
  readonly extensionId: string;
  readonly packageId: string;
  readonly lifecycleState:
    | "prepared"
    | "installed"
    | "disabled"
    | "draining"
    | "waiting"
    | "interrupted"
    | "quarantined"
    | "broken"
    | "unavailable"
    | "uninstalled";
  readonly current?: ExtensionPackageManifest;
  readonly versions: ReadonlyArray<ProjectedExtensionVersion>;
  readonly pending?: ProjectedExtensionPending;
  readonly trusted: boolean;
  readonly pluginDesired: boolean;
  readonly componentDesired: Readonly<Record<string, boolean>>;
  readonly quarantined: boolean;
  readonly draining: boolean;
  readonly broken: boolean;
  readonly unavailable: boolean;
  readonly interrupted: boolean;
  readonly waiting: boolean;
  readonly diagnostics: ReadonlyArray<ExtensionDiagnostic>;
  readonly tombstoned: boolean;
  /**
   * The latest lifecycle commit that ends the remembered tool approvals given
   * before it: an uninstall, a rollback, or withdrawn source trust. A grant
   * journaled before `sequence` no longer stands, whether or not its
   * revocation was ever appended.
   */
  readonly grantsEnded?: {
    readonly sequence: number;
    readonly reason: Exclude<ExtensionToolGrantRevocationReason, "person">;
  };
  readonly aggregateVersion: number;
  readonly lastSequence: number;
}

interface ProjectionRow {
  readonly record_json: string;
  readonly aggregate_version: number;
  readonly last_sequence: number;
}

export class ExtensionProjection implements Projection {
  readonly name = EXTENSION_PROJECTION_NAME;
  readonly dependencies: ReadonlyArray<string> = ["aggregate-heads"];

  reset(connection: SqliteConnection): void {
    connection.exec("DELETE FROM extension_package_projection;");
  }

  apply(connection: SqliteConnection, envelope: EventEnvelope): void {
    if (envelope.eventName !== EXTENSION_LIFECYCLE_EVENT) return;
    assertEnvelope(
      envelope.eventVersion === 1 && envelope.aggregateType === EXTENSION_AGGREGATE_TYPE,
    );
    const event = decodeExtensionLifecycleEvent(envelope.payload);
    assertEnvelope(String(event.extensionId) === String(envelope.aggregateId));
    const existing = readExtensionRecord(connection, event.extensionId);
    if (existing !== undefined && envelope.aggregateVersion <= existing.aggregateVersion) return;
    const next = applyLifecycle(
      existing,
      event,
      envelope.aggregateVersion,
      envelope.globalSequence,
    );
    upsertRecord(connection, next);
  }
}

export function readExtensionRecord(
  connection: SqliteConnection,
  extensionId: string,
): ProjectedExtensionRecord | undefined {
  const row = connection
    .prepare(
      `SELECT record_json, aggregate_version, last_sequence
       FROM extension_package_projection WHERE extension_id = ?`,
    )
    .get(extensionId) as ProjectionRow | undefined;
  return row === undefined ? undefined : decodeRecord(row);
}

export function readExtensionRecords(
  connection: SqliteConnection,
): ReadonlyArray<ProjectedExtensionRecord> {
  return (
    connection
      .prepare(
        `SELECT record_json, aggregate_version, last_sequence
         FROM extension_package_projection ORDER BY extension_id`,
      )
      .all() as ReadonlyArray<ProjectionRow>
  ).map(decodeRecord);
}

export function readExtensionSnapshot(
  connection: SqliteConnection,
  snapshotAt: string,
): ExtensionSnapshot {
  const head = connection
    .prepare("SELECT coalesce(max(global_sequence), 0) AS sequence FROM event_journal")
    .get() as { readonly sequence: number };
  const packages = readExtensionRecords(connection)
    .filter((record) => record.current !== undefined)
    .map(projectPackageState);
  return decodeExtensionSnapshot({ sequence: head.sequence, snapshotAt, packages, collisions: [] });
}

function applyLifecycle(
  existing: ProjectedExtensionRecord | undefined,
  event: ExtensionLifecycleEvent,
  aggregateVersion: number,
  lastSequence: number,
): ProjectedExtensionRecord {
  const payload = event.payload;
  const packageId = "packageId" in payload ? payload.packageId : existing?.packageId;
  assertEnvelope(packageId !== undefined);
  let next: ProjectedExtensionRecord = existing ?? {
    schemaVersion: 1,
    extensionId: event.extensionId,
    packageId,
    lifecycleState: "prepared",
    versions: [],
    trusted: false,
    pluginDesired: false,
    componentDesired: {},
    quarantined: false,
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
    diagnostics: [],
    tombstoned: false,
    aggregateVersion,
    lastSequence,
  };
  assertEnvelope(next.packageId === packageId);
  next = { ...next, aggregateVersion, lastSequence };

  switch (payload.kind) {
    case "install-prepared":
    case "update-prepared":
      return {
        ...withoutPending(next),
        lifecycleState: next.current === undefined ? "prepared" : next.lifecycleState,
        pending: {
          transactionId: payload.transactionId,
          operation: payload.kind === "install-prepared" ? "install" : "update",
          target: target(event.extensionId, payload),
        },
      };
    case "install-committed":
    case "update-committed": {
      const expanded =
        payload.kind === "update-committed" &&
        next.current !== undefined &&
        hasCapabilityExpansion(next.current, payload.manifest);
      const outsideDriver = holdsProviderDriver(payload.manifest);
      const held = expanded || outsideDriver;
      const versions = selectVersion(next.versions, payload.manifest);
      const componentDesired =
        payload.kind === "update-committed" && next.current !== undefined
          ? preserveUnchangedComponentDesired(next.current, payload.manifest, next.componentDesired)
          : {};
      const diagnostics = expanded
        ? appendDiagnostic(next.diagnostics, {
            code: "capability-review-required",
            message: "Updated package capabilities require review.",
          })
        : next.diagnostics;
      return {
        ...withoutPending(next),
        lifecycleState: held ? "quarantined" : "installed",
        current: payload.manifest,
        versions,
        trusted: held ? false : next.trusted,
        pluginDesired: held ? false : next.pluginDesired,
        componentDesired,
        quarantined: held,
        draining: false,
        broken: false,
        unavailable: false,
        interrupted: false,
        waiting: false,
        tombstoned: false,
        diagnostics: outsideDriver
          ? appendDiagnostic(diagnostics, OUTSIDE_DRIVER_QUARANTINE)
          : diagnostics,
      };
    }
    case "rollback-selected":
      return {
        ...withoutPending(next),
        grantsEnded: { sequence: lastSequence, reason: "rolled-back" },
        lifecycleState: holdsProviderDriver(payload.manifest) ? "quarantined" : "installed",
        current: payload.manifest,
        versions: selectVersion(next.versions, payload.manifest),
        trusted: false,
        pluginDesired: false,
        componentDesired: {},
        quarantined: holdsProviderDriver(payload.manifest),
        draining: false,
        broken: false,
        unavailable: false,
        interrupted: false,
        waiting: false,
        tombstoned: false,
      };
    case "transaction-interrupted":
      if (next.pending?.transactionId !== payload.transactionId) return next;
      return {
        ...withoutPending(next),
        lifecycleState: next.current === undefined ? "interrupted" : next.lifecycleState,
        interrupted: next.current === undefined || next.interrupted,
        diagnostics: appendDiagnostic(next.diagnostics, payload.reason),
      };
    case "source-trust-changed":
      return {
        ...next,
        trusted: payload.trusted,
        ...(payload.trusted
          ? {}
          : { grantsEnded: { sequence: lastSequence, reason: "trust-revoked" as const } }),
      };
    case "plugin-desired-state-changed":
      return { ...next, pluginDesired: payload.desired };
    case "component-desired-state-changed":
      return {
        ...next,
        componentDesired: { ...next.componentDesired, [payload.componentId]: payload.desired },
      };
    case "disable-requested":
    case "uninstall-requested":
      return {
        ...next,
        lifecycleState: "draining",
        pluginDesired: false,
        draining: true,
        waiting: false,
      };
    case "disable-waiting":
    case "uninstall-waiting":
      return {
        ...next,
        lifecycleState: "waiting",
        pluginDesired: false,
        draining: true,
        waiting: true,
        diagnostics: appendDiagnostic(next.diagnostics, payload.reason),
      };
    case "package-disabled":
      return {
        ...next,
        lifecycleState: "disabled",
        pluginDesired: false,
        draining: false,
        waiting: false,
      };
    case "package-uninstalled":
      return {
        ...next,
        lifecycleState: "uninstalled",
        grantsEnded: { sequence: lastSequence, reason: "plugin-uninstalled" },
        trusted: false,
        pluginDesired: false,
        componentDesired: {},
        draining: false,
        waiting: false,
        tombstoned: true,
        versions: next.versions.map((version) => ({ ...version, verified: false })),
      };
    case "package-quarantined": {
      const selected =
        next.current?.version === payload.version && next.current.digest === payload.digest;
      return {
        ...next,
        lifecycleState: selected ? "broken" : next.lifecycleState,
        versions: next.versions.map((version) =>
          version.manifest.version === payload.version && version.manifest.digest === payload.digest
            ? { ...version, verified: false, quarantined: true }
            : version,
        ),
        quarantined: selected || next.quarantined,
        broken: selected || next.broken,
        pluginDesired: selected ? false : next.pluginDesired,
        diagnostics: appendDiagnostic(next.diagnostics, payload.reason),
      };
    }
    case "runtime-state-observed":
      return applyRuntimeState(next, payload.state, payload.reason);
    case "package-inspected":
    case "install-requested":
    case "update-requested":
    case "rollback-requested":
      return next;
  }
}

function applyRuntimeState(
  record: ProjectedExtensionRecord,
  state:
    | "starting"
    | "ready"
    | "stopping"
    | "stopped"
    | "disable-pending"
    | "crashed"
    | "quarantined"
    | "draining"
    | "effective"
    | "broken"
    | "unavailable"
    | "interrupted"
    | "waiting",
  reason?: ExtensionDiagnostic,
): ProjectedExtensionRecord {
  return {
    ...record,
    lifecycleState:
      state === "effective" || state === "starting" || state === "ready" || state === "stopped"
        ? "installed"
        : state === "stopping" || state === "disable-pending"
          ? "draining"
          : state === "crashed"
            ? "broken"
            : state,
    quarantined: state === "quarantined" || record.quarantined,
    draining: state === "draining" || state === "stopping" || state === "disable-pending",
    broken: state === "broken" || state === "crashed" || record.broken,
    unavailable: state === "unavailable",
    interrupted: state === "interrupted",
    waiting: state === "waiting",
    diagnostics:
      reason === undefined ? record.diagnostics : appendDiagnostic(record.diagnostics, reason),
  };
}

function projectPackageState(record: ProjectedExtensionRecord): ExtensionPackageState {
  const manifest = record.current!;
  const installed = !record.tombstoned;
  const packageActivation = activation(record, installed, false);
  return {
    extensionId: manifest.extensionId,
    packageId: manifest.packageId,
    slug: manifest.slug,
    displayName: manifest.displayName,
    stateVersion: record.aggregateVersion as never,
    version: manifest.version,
    digest: manifest.digest,
    source: manifest.source,
    compatibility: manifest.compatibility,
    activation: packageActivation,
    components: manifest.components.map((component) => {
      const desired = record.componentDesired[component.id] ?? false;
      const componentActivation = activation(record, installed, desired);
      return {
        component,
        activation: componentActivation,
        effectiveState: blockedState(componentActivation),
      };
    }),
    diagnostics: [...record.diagnostics],
  };
}

function activation(
  record: ProjectedExtensionRecord,
  installed: boolean,
  componentDesired: boolean,
): ExtensionActivationState {
  return {
    installed,
    trusted: installed && record.trusted,
    pluginDesired: installed && record.pluginDesired,
    componentDesired: installed && componentDesired,
    compatible: true,
    policyAllowed: true,
    quarantined: record.quarantined,
    draining: record.draining,
    broken: record.broken,
    unavailable: record.unavailable,
    interrupted: record.interrupted,
    waiting: record.waiting,
  };
}

function blockedState(
  state: ExtensionActivationState,
): ExtensionPackageState["components"][number]["effectiveState"] {
  return resolveExtensionActivation({
    ...state,
    hostAllowed: true,
    modeAllowed: true,
    projectAllowed: true,
    threadAllowed: true,
    catalogCurrent: true,
  });
}

function upsertRecord(connection: SqliteConnection, record: ProjectedExtensionRecord): void {
  connection
    .prepare(
      `INSERT INTO extension_package_projection (
         extension_id, package_id, schema_version, lifecycle_state,
         installed, trusted, plugin_desired, quarantined, broken, waiting,
         record_json, aggregate_version, last_sequence
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (extension_id) DO UPDATE SET
         package_id = excluded.package_id,
         lifecycle_state = excluded.lifecycle_state,
         installed = excluded.installed,
         trusted = excluded.trusted,
         plugin_desired = excluded.plugin_desired,
         quarantined = excluded.quarantined,
         broken = excluded.broken,
         waiting = excluded.waiting,
         record_json = excluded.record_json,
         aggregate_version = excluded.aggregate_version,
         last_sequence = excluded.last_sequence
       WHERE excluded.aggregate_version > extension_package_projection.aggregate_version`,
    )
    .run(
      record.extensionId,
      record.packageId,
      record.lifecycleState,
      record.tombstoned ? 0 : record.current === undefined ? 0 : 1,
      record.trusted ? 1 : 0,
      record.pluginDesired ? 1 : 0,
      record.quarantined ? 1 : 0,
      record.broken ? 1 : 0,
      record.waiting ? 1 : 0,
      JSON.stringify(record),
      record.aggregateVersion,
      record.lastSequence,
    );
}

function decodeRecord(row: ProjectionRow): ProjectedExtensionRecord {
  const parsed = JSON.parse(row.record_json) as ProjectedExtensionRecord;
  assertEnvelope(
    parsed.schemaVersion === 1 &&
      parsed.aggregateVersion === row.aggregate_version &&
      parsed.lastSequence === row.last_sequence &&
      Array.isArray(parsed.versions) &&
      Array.isArray(parsed.diagnostics),
  );
  if (parsed.current !== undefined) decodeExtensionPackageManifest(parsed.current);
  for (const version of parsed.versions) decodeExtensionPackageManifest(version.manifest);
  return parsed;
}

function selectVersion(
  versions: ReadonlyArray<ProjectedExtensionVersion>,
  manifest: ExtensionPackageManifest,
): ReadonlyArray<ProjectedExtensionVersion> {
  const remaining = versions.filter(
    (version) =>
      version.manifest.version !== manifest.version || version.manifest.digest !== manifest.digest,
  );
  return [...remaining, { manifest, verified: true, quarantined: false }].sort((left, right) =>
    `${left.manifest.version}:${left.manifest.digest}`.localeCompare(
      `${right.manifest.version}:${right.manifest.digest}`,
    ),
  );
}

/**
 * Bundled provider drivers are never stored as packages, so a stored package
 * that holds one is an outside driver. It is held quarantined whenever its
 * selected version changes (install, update, rollback), and nothing here
 * lifts that: trust, switches, and runtime evidence leave it in place until
 * the driver's admission, which binds trust to the digest, exists.
 */
function holdsProviderDriver(manifest: ExtensionPackageManifest): boolean {
  return manifest.components.some((component) => component.kind === "provider-driver");
}

const OUTSIDE_DRIVER_QUARANTINE: ExtensionDiagnostic = {
  code: "outside-driver-quarantined",
  message: "An outside provider driver stays quarantined until Octant admits it.",
};

function hasCapabilityExpansion(
  previous: ExtensionPackageManifest,
  next: ExtensionPackageManifest,
): boolean {
  const oldCapabilities = new Set(previous.declaredCapabilities);
  if (next.declaredCapabilities.some((capability) => !oldCapabilities.has(capability))) return true;
  const oldComponents = new Map(previous.components.map((component) => [component.id, component]));
  return next.components.some((component) =>
    componentWidened(oldComponents.get(component.id), component),
  );
}

/**
 * Whether an updated component may do more than the one a person reviewed.
 * A language server's launch class is part of its grant: moving to
 * `repo-tooling` lets it write the checkout, run tooling, and reach the
 * network with the same kind and the same declared capabilities.
 */
function componentWidened(
  prior: ExtensionPackageManifest["components"][number] | undefined,
  component: ExtensionPackageManifest["components"][number],
): boolean {
  return (
    prior === undefined ||
    prior.kind !== component.kind ||
    component.declaredCapabilities.some(
      (capability) => !prior.declaredCapabilities.includes(capability),
    ) ||
    (component.languageServer?.launchClass === "repo-tooling" &&
      prior.languageServer?.launchClass !== "repo-tooling")
  );
}

function preserveUnchangedComponentDesired(
  previous: ExtensionPackageManifest,
  next: ExtensionPackageManifest,
  desired: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
  const previousComponents = new Map(
    previous.components.map((component) => [component.id, component]),
  );
  return Object.fromEntries(
    next.components.flatMap((component) => {
      if (componentWidened(previousComponents.get(component.id), component)) return [];
      const value = desired[component.id];
      return value === undefined ? [] : [[component.id, value]];
    }),
  );
}

function appendDiagnostic(
  diagnostics: ReadonlyArray<ExtensionDiagnostic>,
  diagnostic: ExtensionDiagnostic,
): ReadonlyArray<ExtensionDiagnostic> {
  if (
    diagnostics.some(
      (entry) => entry.code === diagnostic.code && entry.message === diagnostic.message,
    )
  ) {
    return diagnostics;
  }
  return [...diagnostics, diagnostic].slice(-128);
}

function withoutPending(
  record: ProjectedExtensionRecord,
): Omit<ProjectedExtensionRecord, "pending"> {
  const { pending: _pending, ...remaining } = record;
  return remaining;
}

function target(
  extensionId: string,
  payload: { packageId: string; version: string; digest: string },
) {
  return {
    extensionId,
    packageId: payload.packageId,
    version: payload.version,
    digest: payload.digest,
  };
}

function assertEnvelope(condition: boolean): asserts condition {
  if (!condition) throw new Error("Extension lifecycle projection event is inconsistent.");
}
