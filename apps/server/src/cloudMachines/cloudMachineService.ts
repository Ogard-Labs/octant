import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  UtcTimestamp,
  type EventActor as EventActorValue,
} from "@octant/contracts";
import {
  CLOUD_MACHINES_AGGREGATE,
  CLOUD_MACHINES_EVENT_NAMES,
  CloudMachineCreatedPayload,
  CloudMachineCreationEndedPayload,
  CloudMachineCreationRequestedPayload,
  CloudMachineDestroyedPayload,
  CloudMachineProjectBoundPayload,
  CloudMachineStateChangedPayload,
  decodeCloudMachineDescription,
  MAX_CLOUD_MACHINES,
  MAX_SETTLED_CLOUD_MACHINES_SHOWN,
  type CloudMachine,
  type CloudMachineDescription,
  type CloudMachineRecipe,
  type CloudMachinesRefusalReason,
  type CloudMachinesView,
} from "@octant/contracts/cloud-machines";
import type { ServerProjectCloudMachine } from "@octant/contracts/server-projects";
import type {
  CloudCredentialHandle,
  CloudMachineActResult,
  CloudMachineTarget,
} from "@octant/plugin-api/cloud-machine-target";
import type { OfferedCloudMachineTarget } from "@octant/plugin-host/cloud-machine-targets";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import type { ServerProjectStore } from "../serverProjects/serverProjectStore";
import type { ShieldServerStore } from "../shield/shieldServerStore";

/**
 * Machines Octant creates in the person's own cloud account, each bound as a
 * server Project. Canonical: docs/design/server-projects.md § Machines in the
 * person's cloud account.
 *
 * Every create, suspend, resume and destroy is a person's act at a local
 * window; an agent, a routine and a paired device are refused before a
 * target or the credential broker is asked anything. The cloud credential is
 * a broker reference resolved to a handle for one act at a time and never
 * held. The journal records each act; a creation is journaled before the
 * provider is asked, because a machine the person pays for must never exist
 * without a record of it.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeRequested = Schema.decodeUnknownSync(CloudMachineCreationRequestedPayload);
const decodeCreated = Schema.decodeUnknownSync(CloudMachineCreatedPayload);
const decodeEnded = Schema.decodeUnknownSync(CloudMachineCreationEndedPayload);
const decodeBound = Schema.decodeUnknownSync(CloudMachineProjectBoundPayload);
const decodeStateChanged = Schema.decodeUnknownSync(CloudMachineStateChangedPayload);
const decodeDestroyed = Schema.decodeUnknownSync(CloudMachineDestroyedPayload);

const REPLAY_BATCH = 500;
/** States a provider reports while it finishes an act; never a basis for gating the next one. */
const IN_BETWEEN_STATES: ReadonlySet<string> = new Set([
  "provisioning",
  "suspending",
  "resuming",
  "destroying",
  "unknown",
]);
const MAX_DETAIL = 512;
/** Long enough to read the dialog, short enough that a stale one cannot be replayed later. */
const DESTROY_CONFIRMATION_MS = 5 * 60_000;

/** The named refusal every call to a suspended machine's server, and every turn there, gets. */
export const CLOUD_MACHINE_SUSPENDED_MESSAGE =
  "This machine is suspended; resume it first in Settings › Permissions › Servers. Nothing ran.";

export type CloudMachinePrincipal = "local-window" | "remote-device" | "agent" | "routine";
export type CloudMachineAct = "create" | "describe" | "suspend" | "resume" | "destroy";

export type CloudMachinesChange =
  | { readonly kind: "changed"; readonly machine?: CloudMachine; readonly message?: string }
  | {
      readonly kind: "confirm";
      readonly machineId: CloudMachine["id"];
      readonly name: CloudMachine["name"];
      readonly confirmation: string;
      readonly expiresAt: UtcTimestamp;
    }
  | {
      readonly kind: "refused";
      readonly reason: CloudMachinesRefusalReason;
      readonly message?: string;
    };

export interface CloudMachineServiceOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType" | "aggregateVersions">;
  readonly personActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly now: () => number;
  /** The targets the plugin host offers now; read on every act. */
  readonly targets: () => ReadonlyArray<OfferedCloudMachineTarget>;
  /** A purpose-scoped handle from the credential broker for one act, or nothing. */
  readonly credentialHandle: (input: {
    readonly reference: string;
    readonly targetId: string;
    readonly act: CloudMachineAct;
  }) => Promise<CloudCredentialHandle | undefined>;
  readonly servers: Pick<ShieldServerStore, "register" | "servers">;
  readonly projects: Pick<ServerProjectStore, "bind">;
}

export class CloudMachineService {
  readonly #options: CloudMachineServiceOptions;
  readonly #personActor: EventActorValue;
  readonly #machines = new Map<string, CloudMachine>();
  readonly #versions = new Map<string, number>();
  /** Machines with an act in flight; a second act on one is refused, never queued. */
  readonly #busy = new Set<string>();
  readonly #confirmations = new Map<
    string,
    { readonly machineId: string; readonly expiresAt: number }
  >();

  constructor(options: CloudMachineServiceOptions) {
    this.#options = options;
    this.#personActor = decodeActor(options.personActor);
  }

  /** Rebuilds every machine from the journal, in journal order. A record that no longer decodes changes nothing. */
  load(): void {
    this.#machines.clear();
    this.#versions.clear();
    let after = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: CLOUD_MACHINES_AGGREGATE,
        afterSequence: after,
        limit: REPLAY_BATCH,
      });
      for (const envelope of batch) {
        after = envelope.globalSequence;
        try {
          this.#apply(String(envelope.eventName), envelope.payload);
        } catch {
          // An unreadable record changes nothing; the machine keeps what it had.
        }
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    for (const { aggregateId, aggregateVersion } of this.#options.journal.aggregateVersions(
      CLOUD_MACHINES_AGGREGATE,
    )) {
      this.#versions.set(String(aggregateId), aggregateVersion);
    }
  }

  view(): CloudMachinesView {
    return {
      targets: this.#options
        .targets()
        .map(({ targetId, displayName }) => ({ targetId, displayName })),
      machines: shownMachines([...this.#machines.values()]),
    };
  }

  /** The machine behind a server Project, as the Project shows it. */
  machineForProject(projectId: string): ServerProjectCloudMachine | undefined {
    for (const machine of this.#machines.values()) {
      if (String(machine.projectId) !== projectId) continue;
      if (machine.state === undefined || machine.stateObservedAt === undefined) return undefined;
      return {
        machineId: machine.id,
        targetId: machine.targetId,
        state: machine.state,
        stateObservedAt: machine.stateObservedAt,
      };
    }
    return undefined;
  }

  /**
   * The host keys pinned for a server: those the provider reported when it
   * created the live machine at that address. They are fixed at creation; a
   * later answer never changes them, so a machine whose key changed is
   * refused by the strict host check. A destroyed machine pins nothing, so a
   * reused address is not held to an old machine's key.
   */
  pinnedHostKeys(server: {
    readonly alias: string;
    readonly user: string;
  }): ReadonlyArray<string> | undefined {
    return this.#liveAt(server)?.endpoint?.hostKeys;
  }

  /** Why no call may go to a server now: its machine is suspended. */
  suspendedRefusal(server: { readonly alias: string; readonly user: string }): string | undefined {
    return this.#liveAt(server)?.state === "suspended"
      ? CLOUD_MACHINE_SUSPENDED_MESSAGE
      : undefined;
  }

  /** The most recently requested created machine at this address and login, if one is live. */
  #liveAt(server: { readonly alias: string; readonly user: string }): CloudMachine | undefined {
    let found: CloudMachine | undefined;
    for (const machine of this.#machines.values()) {
      if (machine.lifecycle !== "created" || machine.endpoint === undefined) continue;
      if (machine.endpoint.host !== server.alias || machine.endpoint.user !== server.user) continue;
      if (found === undefined || machine.requestedAt >= found.requestedAt) found = machine;
    }
    return found;
  }

  async create(input: {
    readonly targetId: string;
    readonly name: string;
    readonly recipe: CloudMachineRecipe;
    readonly credentialReference: string;
    readonly folder: string;
    readonly mode?: "work" | undefined;
    readonly principal: CloudMachinePrincipal;
  }): Promise<CloudMachinesChange> {
    const person = personRefusal(input.principal);
    if (person !== undefined) return person;
    if (this.#liveCount() >= MAX_CLOUD_MACHINES) return refused("too-many-machines");
    const target = this.#target(input.targetId);
    if (target === undefined) return refused("target-not-offered");
    const credential = await this.#options.credentialHandle({
      reference: input.credentialReference,
      targetId: input.targetId,
      act: "create",
    });
    if (credential === undefined) return refused("credential-unavailable");
    // Read again: another creation may have filled the limit while the broker answered.
    if (this.#liveCount() >= MAX_CLOUD_MACHINES) return refused("too-many-machines");

    const requested = decodeRequested({
      machine: {
        id: this.#options.uuid(),
        targetId: input.targetId,
        name: input.name.trim(),
        recipe: input.recipe,
        credentialReference: input.credentialReference,
        folder: input.folder,
        ...(input.mode === "work" ? { mode: "work" as const } : {}),
        requestedAt: this.#options.clock(),
      },
      principal: { kind: "local-window" },
    });
    const machineId = String(requested.machine.id);
    if (!this.#record(machineId, CLOUD_MACHINES_EVENT_NAMES.creationRequested, requested))
      return refused("unavailable");

    this.#busy.add(machineId);
    try {
      let answer;
      try {
        answer = await target.create({
          name: requested.machine.name,
          recipe: requested.machine.recipe,
          credential,
        });
      } catch {
        return this.#creationEnded(
          machineId,
          "uncertain",
          "The provider did not answer. A machine may exist in your cloud account; check there before creating another.",
        );
      }
      if (answer.status === "refused") {
        return this.#creationEnded(machineId, "refused", answer.detail);
      }
      const described = decodeCloudMachineDescription(answer.machine);
      if (described._tag === "None" || described.value.endpoint === undefined) {
        return this.#creationEnded(
          machineId,
          "uncertain",
          "The provider's answer could not be read. A machine may exist in your cloud account; check there.",
        );
      }
      const created = {
        machineId: requested.machine.id,
        machine: described.value,
        observedAt: this.#options.clock(),
      };
      if (!this.#record(machineId, CLOUD_MACHINES_EVENT_NAMES.created, created)) {
        return refused(
          "unavailable",
          "The machine was created but could not be recorded. Check your cloud account.",
        );
      }
      return await this.#bind(machineId);
    } finally {
      this.#busy.delete(machineId);
    }
  }

  #liveCount(): number {
    return [...this.#machines.values()].filter((machine) => !isSettled(machine)).length;
  }

  /** Registers and binds a created machine again, after a binding that was refused. */
  async bindProject(input: {
    readonly machineId: string;
    readonly principal: CloudMachinePrincipal;
  }): Promise<CloudMachinesChange> {
    const person = personRefusal(input.principal);
    if (person !== undefined) return person;
    const machine = this.#machines.get(input.machineId);
    if (machine === undefined || machine.lifecycle !== "created")
      return refused("machine-not-found");
    if (machine.projectId !== undefined) return { kind: "changed", machine };
    if (this.#busy.has(input.machineId)) return refused("machine-busy");
    this.#busy.add(input.machineId);
    try {
      return await this.#bind(input.machineId);
    } finally {
      this.#busy.delete(input.machineId);
    }
  }

  suspend(input: {
    readonly machineId: string;
    readonly principal: CloudMachinePrincipal;
  }): Promise<CloudMachinesChange> {
    return this.#power(input, "suspend");
  }

  resume(input: {
    readonly machineId: string;
    readonly principal: CloudMachinePrincipal;
  }): Promise<CloudMachinesChange> {
    return this.#power(input, "resume");
  }

  /**
   * The one question a destroy asks. It changes nothing: it hands the person's
   * window a single-use confirmation for exactly this machine, which the
   * destroy must carry back before it expires.
   */
  requestDestroy(input: {
    readonly machineId: string;
    readonly principal: CloudMachinePrincipal;
  }): CloudMachinesChange {
    const person = personRefusal(input.principal);
    if (person !== undefined) return person;
    const machine = this.#machines.get(input.machineId);
    if (machine?.lifecycle !== "created" || machine.providerMachineId === undefined)
      return refused("machine-not-found");
    const confirmation = this.#options.uuid();
    const expiresAt = this.#options.now() + DESTROY_CONFIRMATION_MS;
    this.#confirmations.set(confirmation, { machineId: input.machineId, expiresAt });
    return {
      kind: "confirm",
      machineId: machine.id,
      name: machine.name,
      confirmation,
      expiresAt: decodeTimestamp(new Date(expiresAt).toISOString()),
    };
  }

  async destroy(input: {
    readonly machineId: string;
    readonly confirmation: string;
    readonly principal: CloudMachinePrincipal;
  }): Promise<CloudMachinesChange> {
    const person = personRefusal(input.principal);
    if (person !== undefined) return person;
    const confirmed = this.#confirmations.get(input.confirmation);
    // Spent on first use, matched or not, so a confirmation is never tried twice.
    this.#confirmations.delete(input.confirmation);
    if (
      confirmed === undefined ||
      confirmed.machineId !== input.machineId ||
      confirmed.expiresAt < this.#options.now()
    ) {
      return refused("confirmation-required");
    }
    const ready = this.#ready(input.machineId);
    if (ready.kind === "refused") return ready;
    const { machine, target, providerMachineId } = ready;
    this.#busy.add(input.machineId);
    try {
      const answer = await this.#ask(machine, target, providerMachineId, "destroy");
      if (answer.kind === "refused") return answer;
      return this.#settle(machine, "destroy", answer.result);
    } finally {
      this.#busy.delete(input.machineId);
    }
  }

  /**
   * Asks the provider where a machine stands now and journals its answer.
   * This is how a machine left in between states (a suspend, resume or
   * destroy the provider accepted and finishes later) is reconciled; the
   * same read runs before any act on such a machine.
   */
  async refresh(input: {
    readonly machineId: string;
    readonly principal: CloudMachinePrincipal;
  }): Promise<CloudMachinesChange> {
    const person = personRefusal(input.principal);
    if (person !== undefined) return person;
    const ready = this.#ready(input.machineId);
    if (ready.kind === "refused") return ready;
    this.#busy.add(input.machineId);
    try {
      return await this.#observe(ready.machine, ready.target, ready.providerMachineId);
    } finally {
      this.#busy.delete(input.machineId);
    }
  }

  async #power(
    input: { readonly machineId: string; readonly principal: CloudMachinePrincipal },
    act: "suspend" | "resume",
  ): Promise<CloudMachinesChange> {
    const person = personRefusal(input.principal);
    if (person !== undefined) return person;
    const ready = this.#ready(input.machineId);
    if (ready.kind === "refused") return ready;
    const { target, providerMachineId } = ready;
    this.#busy.add(input.machineId);
    try {
      let machine = ready.machine;
      // A journaled in-between state is only what the provider said when it
      // accepted the last act. Gating on it would refuse every act forever,
      // so read where the machine stands first.
      if (machine.state === undefined || IN_BETWEEN_STATES.has(machine.state)) {
        const observed = await this.#observe(machine, target, providerMachineId);
        if (observed.kind === "refused") return observed;
        const current = this.#machines.get(input.machineId);
        if (current?.lifecycle !== "created") return observed;
        machine = current;
      }
      if (act === "suspend" && machine.state !== "running") return refused("machine-not-running");
      if (act === "resume" && machine.state !== "suspended")
        return refused("machine-not-suspended");
      const answer = await this.#ask(machine, target, providerMachineId, act);
      if (answer.kind === "refused") return answer;
      return this.#settle(machine, act, answer.result);
    } finally {
      this.#busy.delete(input.machineId);
    }
  }

  async #observe(
    machine: CloudMachine,
    target: CloudMachineTarget,
    providerMachineId: string,
  ): Promise<CloudMachinesChange> {
    const answer = await this.#ask(machine, target, providerMachineId, "describe");
    if (answer.kind === "refused") return answer;
    return this.#settle(machine, "observe", answer.result);
  }

  /**
   * Journals what the provider answered. Only a machine the provider no
   * longer has, or reports destroyed, is recorded destroyed; one still
   * `destroying` stays live, counted against the limit and open to refresh,
   * because the person's account may still be paying for it.
   */
  #settle(
    machine: CloudMachine,
    act: "suspend" | "resume" | "destroy" | "observe",
    result:
      | { readonly status: "missing" }
      | { readonly status: "accepted"; readonly machine: CloudMachineDescription },
  ): CloudMachinesChange {
    const machineId = String(machine.id);
    const observedAt = this.#options.clock();
    const principal = { kind: "local-window" as const };
    if (result.status === "missing" || result.machine.state === "destroyed") {
      const payload = { machineId: machine.id, state: "destroyed" as const, observedAt, principal };
      if (!this.#record(machineId, CLOUD_MACHINES_EVENT_NAMES.destroyed, payload))
        return refused("unavailable", "The machine is gone but that could not be recorded.");
    } else {
      const payload = {
        machineId: machine.id,
        act,
        state: result.machine.state,
        observedAt,
        ...(result.machine.costPerHour === undefined
          ? {}
          : { costPerHour: result.machine.costPerHour }),
        principal,
      };
      if (!this.#record(machineId, CLOUD_MACHINES_EVENT_NAMES.stateChanged, payload))
        return refused("unavailable");
    }
    return { kind: "changed", machine: this.#machines.get(machineId) ?? machine };
  }

  /** A created machine with no act in flight, and the target that created it, offered now. */
  #ready(machineId: string):
    | {
        readonly kind: "ready";
        readonly machine: CloudMachine;
        readonly target: CloudMachineTarget;
        readonly providerMachineId: string;
      }
    | Extract<CloudMachinesChange, { readonly kind: "refused" }> {
    const machine = this.#machines.get(machineId);
    if (machine?.lifecycle !== "created" || machine.providerMachineId === undefined)
      return { kind: "refused", reason: "machine-not-found" };
    if (this.#busy.has(machineId)) return { kind: "refused", reason: "machine-busy" };
    const target = this.#target(machine.targetId);
    if (target === undefined) return { kind: "refused", reason: "target-not-offered" };
    return { kind: "ready", machine, target, providerMachineId: machine.providerMachineId };
  }

  /** Asks the target for one act with a handle resolved for it, and reads the answer strictly. */
  async #ask(
    machine: CloudMachine,
    target: CloudMachineTarget,
    providerMachineId: string,
    act: "describe" | "suspend" | "resume" | "destroy",
  ): Promise<
    | {
        readonly kind: "answered";
        readonly result:
          | { readonly status: "missing" }
          | { readonly status: "accepted"; readonly machine: CloudMachineDescription };
      }
    | Extract<CloudMachinesChange, { readonly kind: "refused" }>
  > {
    const credential = await this.#options.credentialHandle({
      reference: machine.credentialReference,
      targetId: machine.targetId,
      act,
    });
    if (credential === undefined) return { kind: "refused", reason: "credential-unavailable" };
    let result: CloudMachineActResult;
    try {
      result = await target[act]({ providerMachineId, credential });
    } catch {
      return {
        kind: "refused",
        reason: "provider-failed",
        message: "The provider did not answer. Check the machine in your cloud account.",
      };
    }
    if (result.status === "refused") {
      return { kind: "refused", reason: "provider-refused", message: bounded(result.detail) };
    }
    if (result.status === "missing") return { kind: "answered", result };
    const described = decodeCloudMachineDescription(result.machine);
    if (described._tag === "None" || described.value.providerMachineId !== providerMachineId) {
      return {
        kind: "refused",
        reason: "provider-failed",
        message:
          "The provider's answer could not be read. Check the machine in your cloud account.",
      };
    }
    return { kind: "answered", result: { status: "accepted", machine: described.value } };
  }

  /**
   * Registers the machine's endpoint as a server, reusing one the person
   * already registered at the same address and login, and binds the
   * Project there through the catalog's own folder check. A refusal leaves
   * the machine created and on record: it costs money whether bound or not,
   * and the person can bind again or destroy it.
   */
  async #bind(machineId: string): Promise<CloudMachinesChange> {
    const machine = this.#machines.get(machineId);
    if (machine?.endpoint === undefined) return refused("machine-not-found");
    const endpoint = machine.endpoint;
    let serverId = this.#options.servers
      .servers()
      .find((server) => server.alias === endpoint.host && server.user === endpoint.user)?.serverId;
    if (serverId === undefined) {
      const registered = this.#options.servers.register({
        server: {
          alias: endpoint.host,
          user: endpoint.user,
          profile: "read-only",
          deployCommands: [],
        },
        principal: "local-window",
      });
      if (registered.kind === "refused" || registered.server === undefined) {
        return {
          kind: "changed",
          machine,
          message: `The machine was created, but its server could not be registered (${registered.kind === "refused" ? registered.reason : "unavailable"}).`,
        };
      }
      serverId = registered.server.serverId;
    }
    const bound = await this.#options.projects.bind({
      name: machine.name,
      serverId: String(serverId),
      folder: machine.folder,
      mode: machine.mode,
      principal: "local-window",
    });
    if (bound.kind === "refused" || bound.project === undefined) {
      return {
        kind: "changed",
        machine,
        message: `The machine was created, but its Project could not be bound (${bound.kind === "refused" ? bound.reason : "unavailable"}).`,
      };
    }
    const payload = {
      machineId: machine.id,
      serverId,
      projectId: bound.project.id,
      principal: { kind: "local-window" as const },
    };
    if (!this.#record(machineId, CLOUD_MACHINES_EVENT_NAMES.projectBound, payload)) {
      return {
        kind: "changed",
        machine,
        message: "The Project was bound but could not be linked to its machine.",
      };
    }
    return { kind: "changed", machine: this.#machines.get(machineId) ?? machine };
  }

  #creationEnded(
    machineId: string,
    outcome: "refused" | "uncertain",
    detail: string,
  ): CloudMachinesChange {
    const payload = { machineId, outcome, detail: bounded(detail) };
    this.#record(machineId, CLOUD_MACHINES_EVENT_NAMES.creationEnded, payload);
    return refused(outcome === "refused" ? "provider-refused" : "provider-failed", payload.detail);
  }

  #target(targetId: string): CloudMachineTarget | undefined {
    return this.#options.targets().find((offered) => offered.targetId === targetId)?.target;
  }

  #apply(eventName: string, payload: unknown): void {
    if (eventName === CLOUD_MACHINES_EVENT_NAMES.creationRequested) {
      const { machine } = decodeRequested(payload);
      this.#machines.set(String(machine.id), { ...machine, lifecycle: "creating" });
      return;
    }
    const machineId = machineIdOf(payload);
    const existing = machineId === undefined ? undefined : this.#machines.get(machineId);
    if (existing === undefined || machineId === undefined) return;
    if (eventName === CLOUD_MACHINES_EVENT_NAMES.created) {
      const created = decodeCreated(payload);
      this.#machines.set(machineId, {
        ...existing,
        lifecycle: "created",
        providerMachineId: created.machine.providerMachineId,
        state: created.machine.state,
        stateObservedAt: created.observedAt,
        ...(created.machine.endpoint === undefined ? {} : { endpoint: created.machine.endpoint }),
        ...(created.machine.costPerHour === undefined
          ? {}
          : { costPerHour: { ...created.machine.costPerHour, observedAt: created.observedAt } }),
      });
    } else if (eventName === CLOUD_MACHINES_EVENT_NAMES.creationEnded) {
      const ended = decodeEnded(payload);
      this.#machines.set(machineId, {
        ...existing,
        lifecycle: ended.outcome === "refused" ? "creation-refused" : "creation-uncertain",
        detail: ended.detail,
      });
    } else if (eventName === CLOUD_MACHINES_EVENT_NAMES.projectBound) {
      const bound = decodeBound(payload);
      this.#machines.set(machineId, {
        ...existing,
        serverId: bound.serverId,
        projectId: bound.projectId,
      });
    } else if (eventName === CLOUD_MACHINES_EVENT_NAMES.stateChanged) {
      const changed = decodeStateChanged(payload);
      this.#machines.set(machineId, {
        ...existing,
        state: changed.state,
        stateObservedAt: changed.observedAt,
        ...(changed.costPerHour === undefined
          ? {}
          : { costPerHour: { ...changed.costPerHour, observedAt: changed.observedAt } }),
      });
    } else if (eventName === CLOUD_MACHINES_EVENT_NAMES.destroyed) {
      const destroyed = decodeDestroyed(payload);
      this.#machines.set(machineId, {
        ...existing,
        lifecycle: "destroyed",
        state: destroyed.state,
        stateObservedAt: destroyed.observedAt,
      });
    }
  }

  /** Journals one event on the machine's own aggregate, then applies it. */
  #record(machineId: string, eventName: string, payload: unknown): boolean {
    const version = this.#versions.get(machineId) ?? 0;
    try {
      this.#options.journal.append({
        aggregate: {
          aggregateType: CLOUD_MACHINES_AGGREGATE,
          aggregateId: decodeAggregateId(machineId),
        },
        expectedVersion: decodeAggregateVersion(version),
        events: [
          {
            eventId: decodeEventId(this.#options.uuid()),
            eventName: decodeEventName(eventName),
            eventVersion: 1,
            correlationId: decodeCorrelationId(this.#options.uuid()),
            actor: this.#personActor,
            occurredAt: decodeTimestamp(this.#options.clock()),
            payload,
          },
        ],
      });
    } catch {
      return false;
    }
    this.#versions.set(machineId, version + 1);
    this.#apply(eventName, payload);
    return true;
  }
}

function personRefusal(
  principal: CloudMachinePrincipal,
): Extract<CloudMachinesChange, { readonly kind: "refused" }> | undefined {
  if (principal === "agent" || principal === "routine") return refused("needs-person");
  // A paired device acts for the host's own person in the design, but the
  // server Project it would bind still refuses one, so it is refused here too.
  if (principal === "remote-device") return refused("needs-local-window");
  return undefined;
}

/** A machine that holds nothing in the person's account any more. */
function isSettled(machine: CloudMachine): boolean {
  return machine.lifecycle === "destroyed" || machine.lifecycle === "creation-refused";
}

/**
 * Every live machine, which the creation limit bounds, and only the most
 * recent settled ones: refused creations and destroyed machines accumulate
 * without limit in the journal, and the view must stay within its schema.
 */
function shownMachines(machines: ReadonlyArray<CloudMachine>): ReadonlyArray<CloudMachine> {
  const settled = machines.filter(isSettled);
  const shownSettled = new Set(settled.slice(-MAX_SETTLED_CLOUD_MACHINES_SHOWN));
  return machines.filter((machine) => !isSettled(machine) || shownSettled.has(machine));
}

function machineIdOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const machineId = (payload as { readonly machineId?: unknown }).machineId;
  return typeof machineId === "string" ? machineId : undefined;
}

function bounded(detail: string): string {
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail;
}

function refused(
  reason: CloudMachinesRefusalReason,
  message?: string,
): Extract<CloudMachinesChange, { readonly kind: "refused" }> {
  return message === undefined ? { kind: "refused", reason } : { kind: "refused", reason, message };
}
