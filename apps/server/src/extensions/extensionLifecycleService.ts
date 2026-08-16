import type { ExtensionLifecycleEvent } from "@octant/contracts/extension-events";
import type { ExtensionCommand, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  EXTENSION_AGGREGATE_TYPE,
  EXTENSION_LIFECYCLE_EVENT,
  readExtensionRecord,
  readExtensionRecords,
  readExtensionSnapshot,
  type ProjectedExtensionRecord,
} from "../persistence/extensionProjection";
import type { InspectedExtensionPackage } from "./packageInspector";
import type { ExtensionPackageManifest } from "@octant/contracts/extensions";
import type { ExtensionPackageStore, ExtensionVersionReference } from "./extensionPackageStore";
import type { ExtensionRuntimeEvidence } from "./extensionSupervisor";

export type ExtensionLifecycleFaultPoint = "after-prepared" | "after-promotion" | "after-commit";

export interface ExtensionSupervisorReceipt {
  readonly extensionId: string;
  readonly packageId: string;
  readonly componentId: string;
  readonly state:
    | "running"
    | "draining"
    | "uncertain"
    | "starting"
    | "ready"
    | "stopping"
    | "stopped"
    | "disable-pending"
    | "crashed"
    | "quarantined";
}

export interface ExtensionSupervisorPort {
  blockNewActivation(extensionId: string): Promise<void>;
  drain(extensionId: string): Promise<{ readonly state: "drained" | "waiting" | "broken" }>;
  unregister(extensionId: string): Promise<void>;
  receipts(): Promise<ReadonlyArray<ExtensionSupervisorReceipt>>;
  reconcile?(): Promise<void>;
}

export class ExtensionLifecycleServiceError extends Error {
  override readonly name = "ExtensionLifecycleServiceError";

  constructor(
    readonly category:
      | "invalid"
      | "conflict"
      | "unavailable"
      | "interrupted"
      | "waiting"
      | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface ExtensionLifecycleServiceOptions {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly store: ExtensionPackageStore;
  readonly supervisor: ExtensionSupervisorPort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly fault?: (point: ExtensionLifecycleFaultPoint) => void;
  readonly isCompatible?: (manifest: ExtensionPackageManifest) => boolean;
}

type ExtensionDesiredStateCommand<K extends ExtensionCommand["kind"]> = Omit<
  Extract<ExtensionCommand, { readonly kind: K }>,
  "kind" | "commandVersion"
>;

export class ExtensionLifecycleService {
  readonly #connection: SqliteConnection;
  readonly #journal: Journal;
  readonly #store: ExtensionPackageStore;
  readonly #supervisor: ExtensionSupervisorPort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #fault: ((point: ExtensionLifecycleFaultPoint) => void) | undefined;
  readonly #isCompatible: (manifest: ExtensionPackageManifest) => boolean;

  constructor(options: ExtensionLifecycleServiceOptions) {
    this.#connection = options.connection;
    this.#journal = options.journal;
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#fault = options.fault;
    this.#isCompatible = options.isCompatible ?? (() => true);
  }

  async install(inspection: InspectedExtensionPackage): Promise<ExtensionSnapshot> {
    const existing = readExtensionRecord(this.#connection, inspection.manifest.extensionId);
    if (existing?.current !== undefined && !existing.tombstoned) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension package is already installed.",
      );
    }
    return this.#promote(inspection, "install");
  }

  async update(inspection: InspectedExtensionPackage): Promise<ExtensionSnapshot> {
    const existing = this.#installedRecord(inspection.manifest.extensionId);
    if (existing.packageId !== inspection.manifest.packageId) {
      throw new ExtensionLifecycleServiceError("invalid", "Extension update target is invalid.");
    }
    if (
      existing.versions.some(
        (version) =>
          version.manifest.version === inspection.manifest.version &&
          version.manifest.digest === inspection.manifest.digest,
      )
    ) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension version is already retained.",
      );
    }
    return this.#promote(inspection, "update");
  }

  async rollback(target: ExtensionVersionReference): Promise<ExtensionSnapshot> {
    const record = this.#installedRecord(target.extensionId);
    const retained = record.versions.find(
      (version) =>
        version.manifest.packageId === target.packageId &&
        version.manifest.version === target.version &&
        version.manifest.digest === target.digest,
    );
    if (
      retained === undefined ||
      !retained.verified ||
      retained.quarantined ||
      !this.#isCompatible(retained.manifest)
    ) {
      throw new ExtensionLifecycleServiceError("invalid", "Rollback version is not verified.");
    }
    if (!(await this.#store.verifyVersion(target))) {
      await this.#store.quarantineVersion(target, "integrity-mismatch");
      this.#append(target.extensionId, {
        kind: "package-quarantined",
        packageId: retained.manifest.packageId,
        version: retained.manifest.version,
        digest: retained.manifest.digest,
        reason: {
          code: "integrity-mismatch",
          message: "Retained extension version failed integrity verification.",
        },
      });
      throw new ExtensionLifecycleServiceError("invalid", "Rollback version is not verified.");
    }
    this.#append(target.extensionId, {
      kind: "rollback-selected",
      packageId: retained.manifest.packageId,
      version: retained.manifest.version,
      digest: retained.manifest.digest,
      manifest: retained.manifest,
    });
    return this.snapshot();
  }

  async setSourceTrust(
    command: ExtensionDesiredStateCommand<"set-source-trust">,
  ): Promise<ExtensionSnapshot> {
    const record = this.#stateMutationRecord(command.extensionId, command.expectedStateVersion);
    if (record.trusted === command.trusted) return this.snapshot();
    this.#append(
      command.extensionId,
      { kind: "source-trust-changed", trusted: command.trusted },
      command.expectedStateVersion,
    );
    return this.snapshot();
  }

  async setPluginDesired(
    command: ExtensionDesiredStateCommand<"set-plugin-desired">,
  ): Promise<ExtensionSnapshot> {
    const record = this.#stateMutationRecord(command.extensionId, command.expectedStateVersion);
    if (record.pluginDesired === command.desired) return this.snapshot();
    this.#append(
      command.extensionId,
      { kind: "plugin-desired-state-changed", desired: command.desired },
      command.expectedStateVersion,
    );
    return this.snapshot();
  }

  async setComponentDesired(
    command: ExtensionDesiredStateCommand<"set-component-desired">,
  ): Promise<ExtensionSnapshot> {
    const record = this.#stateMutationRecord(command.extensionId, command.expectedStateVersion);
    if (!record.current!.components.some((component) => component.id === command.componentId)) {
      throw new ExtensionLifecycleServiceError("invalid", "Extension component is invalid.");
    }
    if ((record.componentDesired[command.componentId] ?? false) === command.desired) {
      return this.snapshot();
    }
    this.#append(
      command.extensionId,
      {
        kind: "component-desired-state-changed",
        componentId: command.componentId,
        desired: command.desired,
      },
      command.expectedStateVersion,
    );
    return this.snapshot();
  }

  async disable(extensionId: string): Promise<ExtensionSnapshot> {
    const record = this.#installedRecord(extensionId);
    this.#append(extensionId, { kind: "disable-requested", packageId: record.packageId as never });
    let drained: { readonly state: "drained" | "waiting" | "broken" };
    try {
      await this.#supervisor.blockNewActivation(extensionId);
      drained = await this.#supervisor.drain(extensionId);
    } catch {
      drained = { state: "broken" };
    }
    if (drained.state !== "drained") {
      this.#append(extensionId, {
        kind: "disable-waiting",
        packageId: record.packageId as never,
        reason: cleanupDiagnostic(drained.state),
      });
      return this.snapshot();
    }
    try {
      await this.#supervisor.unregister(extensionId);
    } catch {
      this.#append(extensionId, {
        kind: "disable-waiting",
        packageId: record.packageId as never,
        reason: cleanupDiagnostic("broken"),
      });
      return this.snapshot();
    }
    this.#append(extensionId, { kind: "package-disabled", packageId: record.packageId as never });
    return this.snapshot();
  }

  async uninstall(extensionId: string): Promise<ExtensionSnapshot> {
    const record = this.#installedRecord(extensionId);
    this.#append(extensionId, {
      kind: "uninstall-requested",
      packageId: record.packageId as never,
    });
    let drained: { readonly state: "drained" | "waiting" | "broken" };
    try {
      await this.#supervisor.blockNewActivation(extensionId);
      drained = await this.#supervisor.drain(extensionId);
    } catch {
      drained = { state: "broken" };
    }
    if (drained.state !== "drained") {
      this.#append(extensionId, {
        kind: "uninstall-waiting",
        packageId: record.packageId as never,
        reason: cleanupDiagnostic(drained.state),
      });
      return this.snapshot();
    }
    try {
      await this.#supervisor.unregister(extensionId);
    } catch {
      this.#append(extensionId, {
        kind: "uninstall-waiting",
        packageId: record.packageId as never,
        reason: cleanupDiagnostic("broken"),
      });
      return this.snapshot();
    }
    try {
      for (const version of record.versions) {
        await this.#store.removeVersion(versionTarget(record.extensionId, version.manifest));
      }
    } catch {
      this.#append(extensionId, {
        kind: "uninstall-waiting",
        packageId: record.packageId as never,
        reason: {
          code: "residue-uncertain",
          message: "Extension package cleanup is uncertain.",
        },
      });
      return this.snapshot();
    }
    this.#append(extensionId, {
      kind: "package-uninstalled",
      packageId: record.packageId as never,
    });
    return this.snapshot();
  }

  async reconcileStartup(): Promise<ExtensionSnapshot> {
    await this.#store.initialize();
    const inventory = await this.#store.inventory();

    for (const item of inventory.filter((candidate) => candidate.kind === "staging")) {
      await this.#store.quarantineStage(item.opaqueId, "startup-interrupted");
      if (item.target === undefined) continue;
      const record = readExtensionRecord(this.#connection, item.target.extensionId);
      if (record?.pending?.transactionId === item.opaqueId) {
        this.#appendInterrupted(record, item.opaqueId);
      }
    }

    for (const item of inventory.filter(
      (candidate) => candidate.kind === "version" && candidate.target === undefined,
    )) {
      await this.#store.quarantineInventoryItem(item, "corrupt-version-record");
    }

    const versionItems = inventory.filter(
      (candidate): candidate is typeof candidate & { readonly target: ExtensionVersionReference } =>
        candidate.kind === "version" && candidate.target !== undefined,
    );
    for (const item of versionItems) {
      const record = readExtensionRecord(this.#connection, item.target.extensionId);
      const retained = record?.versions.find((version) =>
        sameVersion(version.manifest, item.target),
      );
      if (retained === undefined || !retained.verified) {
        await this.#store.quarantineVersion(item.target, "orphaned-version");
        if (record?.pending?.target.digest === item.target.digest) {
          this.#appendInterrupted(record, record.pending.transactionId);
        }
        continue;
      }
      if (!(await this.#store.verifyVersion(item.target))) {
        await this.#store.quarantineVersion(item.target, "integrity-mismatch");
        this.#appendQuarantineIfNeeded(record!, item.target, "integrity-mismatch");
      }
    }

    for (const record of readExtensionRecords(this.#connection)) {
      if (record.pending !== undefined) {
        this.#appendInterrupted(record, record.pending.transactionId);
      }
    }

    const remainingTargets = new Set(
      (await this.#store.inventory())
        .filter((item) => item.kind === "version" && item.target !== undefined)
        .map((item) => versionKey(item.target!)),
    );
    for (const record of readExtensionRecords(this.#connection)) {
      for (const version of record.versions.filter((candidate) => candidate.verified)) {
        const target = versionTarget(record.extensionId, version.manifest);
        if (!remainingTargets.has(versionKey(target))) {
          this.#appendQuarantineIfNeeded(record, target, "version-missing");
        }
      }
    }

    for (const receipt of await this.#supervisor.receipts()) {
      let cleanupState: "waiting" | "broken" | undefined;
      try {
        await this.#supervisor.blockNewActivation(receipt.extensionId);
        const drained = await this.#supervisor.drain(receipt.extensionId);
        if (drained.state === "drained") {
          await this.#supervisor.unregister(receipt.extensionId);
        } else {
          cleanupState = drained.state;
        }
      } catch {
        cleanupState = "broken";
      }
      if (cleanupState !== undefined) {
        const current = readExtensionRecord(this.#connection, receipt.extensionId);
        if (current?.waiting === true) continue;
        this.#append(receipt.extensionId, {
          kind: "runtime-state-observed",
          packageId: (current?.packageId ?? receipt.packageId) as never,
          componentId: receipt.componentId as never,
          state: "waiting",
          reason: cleanupDiagnostic(cleanupState),
        });
      }
    }
    return this.snapshot();
  }

  snapshot(): ExtensionSnapshot {
    return readExtensionSnapshot(this.#connection, this.#clock());
  }

  recordRuntimeEvidence(event: ExtensionRuntimeEvidence): void {
    this.#append(event.extensionId, {
      kind: "runtime-state-observed",
      packageId: event.packageId as never,
      componentId: event.componentId as never,
      state: event.state,
      ...(event.reason === undefined
        ? {}
        : {
            reason: {
              code: `runtime-${event.reason}`,
              message: "Extension runtime lifecycle evidence was recorded.",
            },
          }),
    });
  }

  async #promote(
    inspection: InspectedExtensionPackage,
    operation: "install" | "update",
  ): Promise<ExtensionSnapshot> {
    const staged = await this.#store.stage(inspection);
    try {
      this.#append(inspection.manifest.extensionId, {
        kind: operation === "install" ? "install-prepared" : "update-prepared",
        transactionId: staged.transactionId as never,
        packageId: inspection.manifest.packageId,
        version: inspection.manifest.version,
        digest: inspection.manifest.digest,
        manifest: inspection.manifest,
      });
    } catch (error) {
      await this.#store.quarantineStage(staged.transactionId, "journal-rejected");
      throw error;
    }
    this.#fault?.("after-prepared");
    try {
      await this.#store.promote(staged);
    } catch {
      await this.#store.quarantineStage(staged.transactionId, "promotion-failed");
      const record = readExtensionRecord(this.#connection, inspection.manifest.extensionId);
      if (record?.pending !== undefined) this.#appendInterrupted(record, staged.transactionId);
      throw new ExtensionLifecycleServiceError(
        "interrupted",
        "Extension promotion was interrupted.",
      );
    }
    this.#fault?.("after-promotion");
    this.#append(inspection.manifest.extensionId, {
      kind: operation === "install" ? "install-committed" : "update-committed",
      transactionId: staged.transactionId as never,
      packageId: inspection.manifest.packageId,
      version: inspection.manifest.version,
      digest: inspection.manifest.digest,
      manifest: inspection.manifest,
    });
    this.#fault?.("after-commit");
    return this.snapshot();
  }

  #installedRecord(extensionId: string): ProjectedExtensionRecord {
    const record = readExtensionRecord(this.#connection, extensionId);
    if (record?.current === undefined || record.tombstoned) {
      throw new ExtensionLifecycleServiceError("invalid", "Extension package is not installed.");
    }
    return record;
  }

  #stateMutationRecord(
    extensionId: string,
    expectedStateVersion: number,
  ): ProjectedExtensionRecord {
    const record = this.#installedRecord(extensionId);
    if (record.aggregateVersion !== expectedStateVersion) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension desired state changed; retry.",
      );
    }
    return record;
  }

  #append(
    extensionId: string,
    payload: ExtensionLifecycleEvent["payload"],
    expectedStateVersion?: number,
  ): void {
    const current = readExtensionRecord(this.#connection, extensionId);
    const currentVersion = current?.aggregateVersion ?? 0;
    if (expectedStateVersion !== undefined && currentVersion !== expectedStateVersion) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension desired state changed; retry.",
      );
    }
    const event: ExtensionLifecycleEvent = {
      eventVersion: 1 as never,
      extensionId: extensionId as never,
      payload,
    };
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: EXTENSION_AGGREGATE_TYPE,
          aggregateId: extensionId,
        },
        expectedVersion: expectedStateVersion ?? currentVersion,
        events: [
          {
            eventId: this.#uuid(),
            eventName: EXTENSION_LIFECYCLE_EVENT,
            eventVersion: 1,
            correlationId: this.#uuid(),
            actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
            occurredAt: this.#clock(),
            payload: event,
          },
        ],
      });
    } catch {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension lifecycle journal rejected the operation.",
      );
    }
  }

  #appendInterrupted(record: ProjectedExtensionRecord, transactionId: string): void {
    const pending = record.pending;
    if (pending === undefined || pending.transactionId !== transactionId) return;
    this.#append(record.extensionId, {
      kind: "transaction-interrupted",
      operation: pending.operation,
      transactionId: transactionId as never,
      packageId: pending.target.packageId as never,
      version: pending.target.version as never,
      digest: pending.target.digest as never,
      reason: {
        code: "startup-reconciled",
        message: "Interrupted extension transaction was quarantined.",
      },
    });
  }

  #appendQuarantineIfNeeded(
    record: ProjectedExtensionRecord,
    target: ExtensionVersionReference,
    code: "integrity-mismatch" | "version-missing",
  ): void {
    const version = record.versions.find((candidate) => sameVersion(candidate.manifest, target));
    if (version?.quarantined === true) return;
    this.#append(record.extensionId, {
      kind: "package-quarantined",
      packageId: target.packageId as never,
      version: target.version as never,
      digest: target.digest as never,
      reason: {
        code,
        message:
          code === "integrity-mismatch"
            ? "Extension version failed integrity verification."
            : "Extension version is missing from private storage.",
      },
    });
  }
}

export const NOOP_EXTENSION_SUPERVISOR: ExtensionSupervisorPort = {
  blockNewActivation: async () => undefined,
  drain: async () => ({ state: "drained" }),
  unregister: async () => undefined,
  receipts: async () => [],
};

function versionTarget(
  extensionId: string,
  manifest: {
    readonly packageId: string;
    readonly version: string;
    readonly digest: string;
  },
): ExtensionVersionReference {
  return {
    extensionId,
    packageId: manifest.packageId,
    version: manifest.version,
    digest: manifest.digest,
  };
}

function sameVersion(
  manifest: { readonly packageId: string; readonly version: string; readonly digest: string },
  target: ExtensionVersionReference,
): boolean {
  return (
    manifest.packageId === target.packageId &&
    manifest.version === target.version &&
    manifest.digest === target.digest
  );
}

function versionKey(target: ExtensionVersionReference): string {
  return `${target.extensionId}:${target.packageId}:${target.version}:${target.digest}`;
}

function cleanupDiagnostic(state: "waiting" | "broken") {
  return state === "waiting"
    ? {
        code: "runtime-uncertain" as const,
        message: "Extension runtime cleanup is uncertain.",
      }
    : {
        code: "runtime-broken" as const,
        message: "Extension runtime cleanup failed.",
      };
}
