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
  type ExtensionPublisherKeyFingerprint,
} from "@octant/contracts/extensions";
import { decodeExtensionSnapshot, type ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { EventEnvelope } from "@octant/contracts/events";
import { outsideDriverPublisherStanding } from "@octant/domain/outside-driver-publisher-policy";
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
  /**
   * An outside provider driver held until its source is trusted at the
   * selected digest. It is apart from `quarantined`, which a failed integrity
   * check or the supervisor sets and which trust never lifts. Absent in a
   * record written before admission existed, which reads as not held: such a
   * record's `quarantined` is already set.
   */
  readonly awaitingAdmission?: boolean;
  /**
   * The publisher key pinned for this package name and source, set when the
   * person first trusts a signed version. It outlives an uninstall, since the
   * record's identity is derived from the source and the name; only the
   * person's forget or new-publisher action changes it.
   */
  readonly publisherPin?: ExtensionPublisherKeyFingerprint;
  /**
   * The selected version is signed by a key other than the pin, or by none.
   * Trust does not lift this hold; re-trusting the new publisher or
   * forgetting the pin does.
   */
  readonly publisherChanged?: boolean;
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
      // An outside driver's review is trusting it, so a widened component is
      // held for that admission rather than for a review nothing else lifts.
      const reviewHeld = expanded && !outsideDriver;
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
      return withPublisherStanding({
        ...withoutPending(next),
        lifecycleState: held ? "quarantined" : "installed",
        current: payload.manifest,
        versions,
        trusted: held ? false : next.trusted,
        pluginDesired: held ? false : next.pluginDesired,
        componentDesired,
        quarantined: reviewHeld,
        awaitingAdmission: outsideDriver,
        draining: false,
        broken: false,
        unavailable: false,
        interrupted: false,
        waiting: false,
        tombstoned: false,
        diagnostics: outsideDriver
          ? appendDiagnostic(diagnostics, OUTSIDE_DRIVER_QUARANTINE)
          : diagnostics,
      });
    }
    case "rollback-selected":
      return withPublisherStanding({
        ...withoutPending(next),
        grantsEnded: { sequence: lastSequence, reason: "rolled-back" },
        lifecycleState: holdsProviderDriver(payload.manifest) ? "quarantined" : "installed",
        current: payload.manifest,
        versions: selectVersion(next.versions, payload.manifest),
        trusted: false,
        pluginDesired: false,
        componentDesired: {},
        quarantined: false,
        awaitingAdmission: holdsProviderDriver(payload.manifest),
        draining: false,
        broken: false,
        unavailable: false,
        interrupted: false,
        waiting: false,
        tombstoned: false,
      });
    case "transaction-interrupted":
      if (next.pending?.transactionId !== payload.transactionId) return next;
      return {
        ...withoutPending(next),
        lifecycleState: next.current === undefined ? "interrupted" : next.lifecycleState,
        interrupted: next.current === undefined || next.interrupted,
        diagnostics: appendDiagnostic(next.diagnostics, payload.reason),
      };
    case "source-trust-changed": {
      const trusted = {
        ...next,
        trusted: payload.trusted,
        ...(payload.trusted
          ? {}
          : { grantsEnded: { sequence: lastSequence, reason: "trust-revoked" as const } }),
      };
      return next.current !== undefined && !next.tombstoned && holdsProviderDriver(next.current)
        ? admitOutsideDriver(trusted, payload.trusted)
        : trusted;
    }
    case "publisher-pinned":
      return withPublisherStanding({ ...next, publisherPin: payload.publisherKey });
    case "publisher-replaced": {
      // The new key is pinned and the package stays held until the person
      // trusts it, which is still the review step for its digest.
      const pinned = { ...next, publisherPin: payload.publisherKey, trusted: false };
      return withPublisherStanding(
        next.current !== undefined && !next.tombstoned && holdsProviderDriver(next.current)
          ? admitOutsideDriver(pinned, false)
          : pinned,
      );
    }
    case "publisher-forgotten": {
      const { publisherPin: _forgotten, ...unpinned } = next;
      return withPublisherStanding(unpinned);
    }
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
      // One package serves every instance added from it, each with its own
      // process and crash limit (`outsideDriverProcess.ts`). A crash of one
      // is that instance's to count, so it does not break the package for
      // the others; the evidence is still kept.
      if (payload.state === "crashed" && isProviderDriverComponent(next, payload.componentId)) {
        return payload.reason === undefined
          ? next
          : { ...next, diagnostics: appendDiagnostic(next.diagnostics, payload.reason) };
      }
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
    ...(holdsProviderDriver(manifest) && publisherState(record) !== undefined
      ? { publisher: publisherState(record) }
      : {}),
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
    quarantined: isQuarantined(record),
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
      isQuarantined(record) ? 1 : 0,
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
 * that holds one is an outside driver. It is held for admission whenever its
 * selected version changes (install, update, rollback), and switches and
 * runtime evidence leave that hold in place.
 */
function holdsProviderDriver(manifest: ExtensionPackageManifest): boolean {
  return manifest.components.some((component) => component.kind === "provider-driver");
}

function isProviderDriverComponent(record: ProjectedExtensionRecord, componentId: string): boolean {
  return (
    record.current?.components.some(
      (component) => component.id === componentId && component.kind === "provider-driver",
    ) === true
  );
}

function isQuarantined(record: ProjectedExtensionRecord): boolean {
  return (
    record.quarantined || record.awaitingAdmission === true || record.publisherChanged === true
  );
}

/**
 * Sets the publisher hold from the pin and the key that signed the selected
 * version, for an outside driver. A package that holds no driver has no
 * publisher standing.
 */
function withPublisherStanding(record: ProjectedExtensionRecord): ProjectedExtensionRecord {
  const { publisherChanged: _previous, ...rest } = record;
  const changed =
    record.current !== undefined &&
    holdsProviderDriver(record.current) &&
    outsideDriverPublisherStanding(record.publisherPin, record.current.provenance.publisherKey)
      .kind === "publisher-changed";
  const diagnostics = changed
    ? appendDiagnostic(record.diagnostics, OUTSIDE_DRIVER_PUBLISHER_CHANGED)
    : record.diagnostics.filter(
        (diagnostic) => diagnostic.code !== OUTSIDE_DRIVER_PUBLISHER_CHANGED.code,
      );
  return changed ? { ...rest, publisherChanged: true, diagnostics } : { ...rest, diagnostics };
}

const OUTSIDE_DRIVER_PUBLISHER_CHANGED: ExtensionDiagnostic = {
  code: "outside-driver-publisher-changed",
  message:
    "Another publisher signed this provider driver. It stays held until you trust the new publisher or forget the old one.",
};

function publisherState(record: ProjectedExtensionRecord): ExtensionPackageState["publisher"] {
  const selected = record.current?.provenance.publisherKey;
  if (record.publisherPin === undefined && selected === undefined) return undefined;
  return {
    ...(record.publisherPin === undefined ? {} : { pinned: record.publisherPin }),
    ...(selected === undefined ? {} : { selected }),
    ...(record.publisherChanged === true ? { held: "publisher-changed" as const } : {}),
  };
}

/**
 * Trusting an outside driver's source is its admission: it lifts the hold for
 * the version and digest selected now. Any later change of selection holds it
 * again and clears trust, so trust never outlives the digest it was given
 * for. Withdrawing trust holds it again, so trusting stays the review step. A
 * quarantine from a failed integrity check or the supervisor is not this hold
 * and stays.
 */
function admitOutsideDriver(
  record: ProjectedExtensionRecord,
  trusted: boolean,
): ProjectedExtensionRecord {
  if (!trusted) {
    return {
      ...record,
      awaitingAdmission: true,
      lifecycleState: "quarantined",
      diagnostics: appendDiagnostic(record.diagnostics, OUTSIDE_DRIVER_QUARANTINE),
    };
  }
  // A publisher hold is not lifted by trust: only re-trusting the new
  // publisher or forgetting the pin does.
  if (record.awaitingAdmission !== true || record.publisherChanged === true) return record;
  return {
    ...record,
    awaitingAdmission: false,
    lifecycleState:
      record.lifecycleState === "quarantined" && !record.quarantined
        ? "installed"
        : record.lifecycleState,
    diagnostics: record.diagnostics.filter(
      (diagnostic) => diagnostic.code !== OUTSIDE_DRIVER_QUARANTINE.code,
    ),
  };
}

const OUTSIDE_DRIVER_QUARANTINE: ExtensionDiagnostic = {
  code: "outside-driver-quarantined",
  message: "An outside provider driver stays quarantined until you trust its source.",
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
 * network with the same kind and the same declared capabilities. A debug
 * adapter's `launch` body decides how the program it runs is started, and a
 * debug port opens loopback, so a changed body or an added port is new too,
 * as is debugging children or announcing them another way.
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
      prior.languageServer?.launchClass !== "repo-tooling") ||
    (component.debugAdapter !== undefined &&
      (prior.debugAdapter === undefined ||
        component.debugAdapter.debugPorts > prior.debugAdapter.debugPorts ||
        // Debugging children opens a connection into the capsule and, on
        // macOS, loopback ports; announcing them differently is a new grant.
        (component.debugAdapter.childSessions ?? 0) > (prior.debugAdapter.childSessions ?? 0) ||
        canonicalJson(component.debugAdapter.childAnnouncement ?? null) !==
          canonicalJson(prior.debugAdapter.childAnnouncement ?? null) ||
        canonicalJson(component.debugAdapter.launchArguments) !==
          canonicalJson(prior.debugAdapter.launchArguments)))
  );
}

/** JSON with every object's keys sorted, so key order alone is not a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
