import type { EventActor } from "@octant/contracts";
import type { ExtensionLifecycleEvent } from "@octant/contracts/extension-events";
import type { ExtensionCommand, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  EXTENSION_AGGREGATE_TYPE,
  EXTENSION_LIFECYCLE_EVENT,
  hasCapabilityExpansion,
  readExtensionRecord,
  readExtensionRecords,
  readExtensionSnapshot,
  type ProjectedExtensionRecord,
} from "../persistence/extensionProjection";
import type { InspectedExtensionPackage } from "./packageInspector";
import type { ExtensionPackageManifest } from "@octant/contracts/extensions";
import type { ExtensionPackageStore, ExtensionVersionReference } from "./extensionPackageStore";
import {
  decideOutsideDriverNewPublisher,
  outsideDriverPublisherPinAtTrust,
  outsideDriverUpdateKeepsTrust,
  sameExtensionSource,
  unsignedUpdateKeepsApprovals,
} from "@octant/domain/outside-driver-publisher-policy";
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

  /**
   * Installs a package. With `trust`, the person's one confirmation also
   * trusts its source, and with `enable` beside it also turns the package
   * and each of its components on. The journal holds the install, the trust,
   * and each switch as their own events. If the trust is refused (a driver
   * whose publisher changed), the package stays installed untrusted and
   * nothing is turned on; `enable` without `trust` turns nothing on either.
   */
  async install(
    inspection: InspectedExtensionPackage,
    options: { readonly trust?: boolean; readonly enable?: boolean } = {},
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
    const existing = readExtensionRecord(this.#connection, inspection.manifest.extensionId);
    if (existing?.current !== undefined && !existing.tombstoned) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension package is already installed.",
      );
    }
    const installed = await this.#promote(inspection, "install", actor);
    if (options.trust !== true) return installed;
    const record = this.#installedRecord(inspection.manifest.extensionId);
    try {
      const trusted = await this.setSourceTrust(
        {
          extensionId: inspection.manifest.extensionId as never,
          expectedStateVersion: record.aggregateVersion as never,
          trusted: true,
        },
        actor,
      );
      if (options.enable !== true) return trusted;
      return this.#turnOn(inspection.manifest.extensionId, actor);
    } catch (error) {
      // A refused trust leaves the install in place, untrusted, as the person
      // would have it after Confirm install; they trust it from Installed.
      if (error instanceof ExtensionLifecycleServiceError) return this.snapshot();
      throw error;
    }
  }

  /**
   * Turns a trusted package and every one of its components on, as the
   * separate switches would. A component held for review or admission stays
   * held: a switch never lifts a hold.
   */
  #turnOn(extensionId: string, actor: EventActor | undefined): ExtensionSnapshot {
    const record = this.#installedRecord(extensionId);
    if (!record.trusted) return this.snapshot();
    this.#append(
      extensionId,
      [
        ...(record.pluginDesired
          ? []
          : [{ kind: "plugin-desired-state-changed" as const, desired: true }]),
        ...installedManifest(record)
          .components.filter((component) => record.componentDesired[component.id] !== true)
          .map((component) => ({
            kind: "component-desired-state-changed" as const,
            componentId: component.id,
            desired: true,
          })),
      ],
      undefined,
      actor,
    );
    return this.snapshot();
  }

  /**
   * The one flow that admits an outside provider driver: install, trust the
   * source, then switch on the plugin and its driver component, on the
   * person's one confirmation of the review. Each step is the separate
   * action's own method, so it journals and refuses exactly as that action
   * does. A refused step stops the flow and the steps before it stand;
   * `stoppedAt` names it. Any other package is refused before it is
   * installed, because enabling a plugin stays its own switch.
   */
  async admitOutsideDriver(
    inspection: InspectedExtensionPackage,
    actor?: EventActor,
  ): Promise<{
    readonly snapshot: ExtensionSnapshot;
    readonly stoppedAt?: "trust" | "enable";
  }> {
    if (!holdsProviderDriver(inspection.manifest)) {
      throw new ExtensionLifecycleServiceError(
        "invalid",
        "Only an outside provider driver installs, trusts and switches on in one step.",
      );
    }
    const { extensionId } = inspection.manifest;
    await this.install(inspection, {}, actor);
    // Read before each step: every step advances the version the next expects.
    const expectedStateVersion = () => {
      const state = this.snapshot().packages.find(
        (candidate) => String(candidate.extensionId) === String(extensionId),
      );
      if (state === undefined) {
        throw new ExtensionLifecycleServiceError("invalid", "Extension package is not installed.");
      }
      return state.stateVersion;
    };
    const steps = [
      {
        step: "trust" as const,
        run: () =>
          this.setSourceTrust(
            {
              extensionId,
              expectedStateVersion: expectedStateVersion(),
              trusted: true,
            },
            actor,
          ),
      },
      {
        step: "enable" as const,
        run: () =>
          this.setPluginDesired(
            {
              extensionId,
              expectedStateVersion: expectedStateVersion(),
              desired: true,
            },
            actor,
          ),
      },
      ...inspection.manifest.components
        .filter((component) => component.kind === "provider-driver")
        .map((component) => ({
          step: "enable" as const,
          run: () =>
            this.setComponentDesired(
              {
                extensionId,
                expectedStateVersion: expectedStateVersion(),
                componentId: component.id,
                desired: true,
              },
              actor,
            ),
        })),
    ];
    for (const { step, run } of steps) {
      try {
        await run();
      } catch (error) {
        if (error instanceof ExtensionLifecycleServiceError) {
          return { snapshot: this.snapshot(), stoppedAt: step };
        }
        throw error;
      }
    }
    return { snapshot: this.snapshot() };
  }

  async update(
    inspection: InspectedExtensionPackage,
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
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
    // An outside driver's update is held until it is trusted again, because
    // trust is given to one digest. An update the pinned publisher key signed
    // keeps the trust and the on switch the package had: both are journaled
    // again after the update's own commit, so the journal shows why the new
    // version runs. A new or missing key stays held and asks.
    const previous = existing.current;
    const driver = holdsProviderDriver(inspection.manifest);
    const capabilitiesWidened =
      previous !== undefined && hasCapabilityExpansion(previous, inspection.manifest);
    const keepsTrust =
      previous !== undefined &&
      driver &&
      outsideDriverUpdateKeepsTrust({
        trusted: existing.trusted,
        pinned: existing.publisherPin,
        updated: inspection.manifest.provenance.publisherKey,
        capabilitiesWidened,
      });
    // Any other package keeps its trust across an update that may do no
    // more. What an unsigned one needs journaled is that the update came
    // from the source the person trusted: that is what lets the approvals
    // its tools were given hold, and what the Updated notice and its roll
    // back read. A driver is admitted digest by digest and is left out.
    const keptFromSource =
      previous !== undefined &&
      !driver &&
      unsignedUpdateKeepsApprovals({
        trusted: existing.trusted,
        pinned: existing.publisherPin,
        previous: previous.provenance.publisherKey,
        updated: inspection.manifest.provenance.publisherKey,
        sameSource: sameExtensionSource(
          { source: previous.source, npm: previous.provenance.npm },
          { source: inspection.manifest.source, npm: inspection.manifest.provenance.npm },
        ),
        capabilitiesWidened,
      });
    // The kept-from-source fact rides in the same journal append as
    // `update-committed`: appended separately, a stop between the two left
    // the update trusted but without its Updated notice, roll back and
    // update line, and nothing at startup or on retry could rebuild them.
    const updated = await this.#promote(
      inspection,
      "update",
      actor,
      keptFromSource && previous !== undefined
        ? [
            {
              kind: "update-kept-from-source",
              packageId: inspection.manifest.packageId,
              version: inspection.manifest.version,
              digest: inspection.manifest.digest,
              previousVersion: previous.version,
              previousDigest: previous.digest,
            },
          ]
        : [],
    );
    if (keptFromSource || !keepsTrust) return updated;
    this.#append(
      inspection.manifest.extensionId,
      [
        { kind: "source-trust-changed", trusted: true },
        ...(existing.pluginDesired
          ? [{ kind: "plugin-desired-state-changed" as const, desired: true }]
          : []),
      ],
      undefined,
      actor,
    );
    return this.snapshot();
  }

  /**
   * Selects a retained version again. A roll back leaves the package
   * untrusted and off and ends its remembered approvals. With `restoreTrust`,
   * and only when the target is the version an Updated notice names, the
   * trust and the switches the package had are journaled again after it:
   * the person is returning to the digest they trusted.
   */
  async rollback(
    target: ExtensionVersionReference & { readonly restoreTrust?: boolean | undefined },
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
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
      this.#append(
        target.extensionId,
        {
          kind: "package-quarantined",
          packageId: retained.manifest.packageId,
          version: retained.manifest.version,
          digest: retained.manifest.digest,
          reason: {
            code: "integrity-mismatch",
            message: "Retained extension version failed integrity verification.",
          },
        },
        undefined,
        actor,
      );
      throw new ExtensionLifecycleServiceError("invalid", "Rollback version is not verified.");
    }
    const update = record.sourceUpdate;
    const restores =
      target.restoreTrust === true &&
      record.trusted &&
      update !== undefined &&
      record.current?.version === update.version &&
      record.current.digest === update.digest &&
      retained.manifest.version === update.previousVersion &&
      retained.manifest.digest === update.previousDigest;
    this.#append(
      target.extensionId,
      {
        kind: "rollback-selected",
        packageId: retained.manifest.packageId,
        version: retained.manifest.version,
        digest: retained.manifest.digest,
        manifest: retained.manifest,
      },
      undefined,
      actor,
    );
    if (!restores) return this.snapshot();
    this.#append(
      target.extensionId,
      [
        { kind: "source-trust-changed", trusted: true },
        ...(record.pluginDesired
          ? [{ kind: "plugin-desired-state-changed" as const, desired: true }]
          : []),
        ...retained.manifest.components
          .filter((component) => record.componentDesired[component.id] === true)
          .map((component) => ({
            kind: "component-desired-state-changed" as const,
            componentId: component.id,
            desired: true,
          })),
      ],
      undefined,
      actor,
    );
    return this.snapshot();
  }

  async setSourceTrust(
    command: ExtensionDesiredStateCommand<"set-source-trust">,
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
    const record = this.#stateMutationRecord(command.extensionId, command.expectedStateVersion);
    if (record.trusted === command.trusted) return this.snapshot();
    // Trust is not how a new publisher is accepted; that is its own action,
    // which shows the person both keys.
    if (command.trusted && record.publisherChanged === true) {
      throw new ExtensionLifecycleServiceError(
        "invalid",
        "Another publisher signed this package; trust the new publisher first.",
      );
    }
    const manifest = installedManifest(record);
    const pin = command.trusted
      ? outsideDriverPublisherPinAtTrust(record.publisherPin, manifest.provenance.publisherKey)
      : undefined;
    this.#append(
      command.extensionId,
      [
        { kind: "source-trust-changed", trusted: command.trusted },
        // The first trust of a signed version pins its key for this package
        // name and source, in the same append as the trust it rests on.
        ...(pin === undefined
          ? []
          : [
              {
                kind: "publisher-pinned" as const,
                packageId: manifest.packageId,
                publisherKey: pin,
              },
            ]),
      ],
      command.expectedStateVersion,
      actor,
    );
    return this.snapshot();
  }

  /**
   * Re-trusts the publisher of a package held because another key, the one
   * the person confirms, signed its selected version. The new key
   * replaces the pin and the package stays held until the person trusts it.
   */
  async trustNewPublisher(
    command: ExtensionDesiredStateCommand<"trust-new-publisher">,
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
    const record = this.#stateMutationRecord(command.extensionId, command.expectedStateVersion);
    const manifest = installedManifest(record);
    const decision = decideOutsideDriverNewPublisher({
      pinned: record.publisherPin,
      selected: manifest.provenance.publisherKey,
      confirmed: command.publisherKey,
    });
    if (decision.kind === "refused") {
      throw new ExtensionLifecycleServiceError("invalid", "No new publisher is waiting for trust.");
    }
    this.#append(
      command.extensionId,
      {
        kind: "publisher-replaced",
        packageId: manifest.packageId,
        previousPublisherKey: decision.previous,
        publisherKey: decision.next,
      },
      command.expectedStateVersion,
      actor,
    );
    return this.snapshot();
  }

  /**
   * Forgets the publisher key pinned for a package name and source. The pin
   * outlives an uninstall, so this works on an uninstalled package as well.
   */
  async forgetPublisher(
    command: ExtensionDesiredStateCommand<"forget-publisher">,
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
    const record = readExtensionRecord(this.#connection, command.extensionId);
    if (record === undefined || record.publisherPin !== command.publisherKey) {
      throw new ExtensionLifecycleServiceError("invalid", "That publisher is not pinned.");
    }
    if (record.aggregateVersion !== command.expectedStateVersion) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension desired state changed; retry.",
      );
    }
    this.#append(
      command.extensionId,
      {
        kind: "publisher-forgotten",
        packageId: record.packageId as never,
        publisherKey: command.publisherKey,
      },
      command.expectedStateVersion,
      actor,
    );
    return this.snapshot();
  }

  async setPluginDesired(
    command: ExtensionDesiredStateCommand<"set-plugin-desired">,
    actor?: EventActor,
  ): Promise<ExtensionSnapshot> {
    const record = this.#stateMutationRecord(command.extensionId, command.expectedStateVersion);
    if (record.pluginDesired === command.desired) return this.snapshot();
    this.#append(
      command.extensionId,
      { kind: "plugin-desired-state-changed", desired: command.desired },
      command.expectedStateVersion,
      actor,
    );
    return this.snapshot();
  }

  async setComponentDesired(
    command: ExtensionDesiredStateCommand<"set-component-desired">,
    actor?: EventActor,
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
      actor,
    );
    return this.snapshot();
  }

  async disable(extensionId: string, actor?: EventActor): Promise<ExtensionSnapshot> {
    const record = this.#installedRecord(extensionId);
    this.#append(
      extensionId,
      { kind: "disable-requested", packageId: record.packageId as never },
      undefined,
      actor,
    );
    let drained: { readonly state: "drained" | "waiting" | "broken" };
    try {
      await this.#supervisor.blockNewActivation(extensionId);
      drained = await this.#supervisor.drain(extensionId);
    } catch {
      drained = { state: "broken" };
    }
    if (drained.state !== "drained") {
      this.#append(
        extensionId,
        {
          kind: "disable-waiting",
          packageId: record.packageId as never,
          reason: cleanupDiagnostic(drained.state),
        },
        undefined,
        actor,
      );
      return this.snapshot();
    }
    try {
      await this.#supervisor.unregister(extensionId);
    } catch {
      this.#append(
        extensionId,
        {
          kind: "disable-waiting",
          packageId: record.packageId as never,
          reason: cleanupDiagnostic("broken"),
        },
        undefined,
        actor,
      );
      return this.snapshot();
    }
    this.#append(
      extensionId,
      { kind: "package-disabled", packageId: record.packageId as never },
      undefined,
      actor,
    );
    return this.snapshot();
  }

  async uninstall(extensionId: string, actor?: EventActor): Promise<ExtensionSnapshot> {
    const record = this.#installedRecord(extensionId);
    this.#append(
      extensionId,
      {
        kind: "uninstall-requested",
        packageId: record.packageId as never,
      },
      undefined,
      actor,
    );
    let drained: { readonly state: "drained" | "waiting" | "broken" };
    try {
      await this.#supervisor.blockNewActivation(extensionId);
      drained = await this.#supervisor.drain(extensionId);
    } catch {
      drained = { state: "broken" };
    }
    if (drained.state !== "drained") {
      this.#append(
        extensionId,
        {
          kind: "uninstall-waiting",
          packageId: record.packageId as never,
          reason: cleanupDiagnostic(drained.state),
        },
        undefined,
        actor,
      );
      return this.snapshot();
    }
    try {
      await this.#supervisor.unregister(extensionId);
    } catch {
      this.#append(
        extensionId,
        {
          kind: "uninstall-waiting",
          packageId: record.packageId as never,
          reason: cleanupDiagnostic("broken"),
        },
        undefined,
        actor,
      );
      return this.snapshot();
    }
    try {
      for (const version of record.versions) {
        await this.#store.removeVersion(versionTarget(record.extensionId, version.manifest));
      }
    } catch {
      this.#append(
        extensionId,
        {
          kind: "uninstall-waiting",
          packageId: record.packageId as never,
          reason: {
            code: "residue-uncertain",
            message: "Extension package cleanup is uncertain.",
          },
        },
        undefined,
        actor,
      );
      return this.snapshot();
    }
    this.#append(
      extensionId,
      {
        kind: "package-uninstalled",
        packageId: record.packageId as never,
      },
      undefined,
      actor,
    );
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
    actor: EventActor | undefined,
    committedWith: ReadonlyArray<ExtensionLifecycleEvent["payload"]> = [],
  ): Promise<ExtensionSnapshot> {
    const staged = await this.#store.stage(inspection);
    try {
      this.#append(
        inspection.manifest.extensionId,
        {
          kind: operation === "install" ? "install-prepared" : "update-prepared",
          transactionId: staged.transactionId as never,
          packageId: inspection.manifest.packageId,
          version: inspection.manifest.version,
          digest: inspection.manifest.digest,
          manifest: inspection.manifest,
        },
        undefined,
        actor,
      );
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
    this.#append(
      inspection.manifest.extensionId,
      [
        {
          kind: operation === "install" ? "install-committed" : "update-committed",
          transactionId: staged.transactionId as never,
          packageId: inspection.manifest.packageId,
          version: inspection.manifest.version,
          digest: inspection.manifest.digest,
          manifest: inspection.manifest,
        },
        ...committedWith,
      ],
      undefined,
      actor,
    );
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
    payloads:
      | ExtensionLifecycleEvent["payload"]
      | ReadonlyArray<ExtensionLifecycleEvent["payload"]>,
    expectedStateVersion?: number,
    // Who asked for the change, as the route resolved it from the
    // authenticated principal. The host's own reconciliation names nobody and
    // keeps the local user it always recorded.
    actor: EventActor = { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  ): void {
    const current = readExtensionRecord(this.#connection, extensionId);
    const currentVersion = current?.aggregateVersion ?? 0;
    if (expectedStateVersion !== undefined && currentVersion !== expectedStateVersion) {
      throw new ExtensionLifecycleServiceError(
        "conflict",
        "Extension desired state changed; retry.",
      );
    }
    const events = (Array.isArray(payloads) ? payloads : [payloads]).map(
      (payload: ExtensionLifecycleEvent["payload"]): ExtensionLifecycleEvent => ({
        eventVersion: 1 as never,
        extensionId: extensionId as never,
        payload,
      }),
    );
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: EXTENSION_AGGREGATE_TYPE,
          aggregateId: extensionId,
        },
        expectedVersion: expectedStateVersion ?? currentVersion,
        events: events.map((event) => ({
          eventId: this.#uuid(),
          eventName: EXTENSION_LIFECYCLE_EVENT,
          eventVersion: 1,
          correlationId: this.#uuid(),
          actor,
          occurredAt: this.#clock(),
          payload: event,
        })),
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

function installedManifest(record: ProjectedExtensionRecord): ExtensionPackageManifest {
  if (record.current === undefined) {
    throw new ExtensionLifecycleServiceError("invalid", "Extension package is not installed.");
  }
  return record.current;
}

/** Bundled drivers are never stored as packages, so one that holds a driver is an outside driver. */
function holdsProviderDriver(manifest: ExtensionPackageManifest): boolean {
  return manifest.components.some((component) => component.kind === "provider-driver");
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
