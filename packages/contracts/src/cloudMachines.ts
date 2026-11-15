/**
 * Machines Octant creates in the person's own cloud account and binds as a
 * server Project. Canonical: docs/design/server-projects.md § Machines in the
 * person's cloud account.
 *
 * A machine is created, suspended, resumed and destroyed by a cloud machine
 * target plugin, always as a person's act. The cloud credential is named by a
 * credential-broker reference; no payload here carries a secret, a key, or a
 * key path. The recipe and the provider's answers are bounded and decoded
 * strictly, because both reach the journal.
 */

import { Schema } from "effect";
import { AggregateId, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import {
  CloudMachineState,
  ServerFolderPath,
  ServerProjectMode,
  ServerProjectName,
} from "./serverProjects";
import { ShieldServerAlias, ShieldServerUser } from "./shieldServers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const CLOUD_MACHINES_AGGREGATE = "cloud-machines";
export const CLOUD_MACHINES_EVENT_NAMES = {
  creationRequested: "cloud-machines.creation-requested@1",
  created: "cloud-machines.created@1",
  creationEnded: "cloud-machines.creation-ended@1",
  projectBound: "cloud-machines.project-bound@1",
  stateChanged: "cloud-machines.state-changed@1",
  destroyed: "cloud-machines.destroyed@1",
} as const;

/** Machines that may hold something in the person's account at once. */
export const MAX_CLOUD_MACHINES = 32;
/** Destroyed machines and refused creations the view still lists, most recent first kept. */
export const MAX_SETTLED_CLOUD_MACHINES_SHOWN = 16;
export const MAX_CLOUD_MACHINE_SETUP_SCRIPT_BYTES = 16_384;

const boundedToken = (max: number) =>
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(max),
    Schema.filter((value) => !/\s/.test(value) && !value.includes("\u0000")),
  );

/** A target as the plugin host names it: the plugin and its component. */
export const CloudMachineTargetId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[a-z0-9][a-z0-9._/-]*$/),
);
export type CloudMachineTargetId = typeof CloudMachineTargetId.Type;

/** The credential broker's reference for the cloud account; never its value. */
export const CloudCredentialReference = Schema.UUID;
export type CloudCredentialReference = typeof CloudCredentialReference.Type;

/**
 * What to create. Image, size and region are the provider's own names, which
 * the target plugin validates; the setup script runs once on the new machine.
 */
export const CloudMachineRecipe = Schema.Struct({
  image: boundedToken(256),
  size: boundedToken(128),
  region: boundedToken(128),
  setupScript: Schema.optional(
    Schema.String.pipe(
      Schema.maxLength(MAX_CLOUD_MACHINE_SETUP_SCRIPT_BYTES),
      Schema.filter((script) => !script.includes("\u0000")),
    ),
  ),
}).annotations(strict);
export type CloudMachineRecipe = typeof CloudMachineRecipe.Type;
export const decodeCloudMachineRecipe = Schema.decodeUnknownSync(CloudMachineRecipe);

/**
 * One SSH host public key as the provider reports it, in the `known_hosts`
 * form after the host pattern: the key type, one space, and the base64 key.
 * Only OpenSSH's current host key types are accepted, and nothing else may
 * ride on the line, because the host writes it into a known hosts file.
 */
export const SshHostPublicKey = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.pattern(
    /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/,
  ),
);
export type SshHostPublicKey = typeof SshHostPublicKey.Type;

/**
 * Where the existing server Project connection reaches the machine: a host
 * name or address and a login, on port 22. It is registered as a server like
 * any other, so the person's SSH agent still signs the login. `hostKeys` are
 * the machine's own host keys as its provider reported them at creation; the
 * host pins them for that server, so the strict host check accepts the new
 * machine and refuses any other key. Without them the person's known hosts
 * decide, as for any registered server.
 */
export const CloudMachineSshEndpoint = Schema.Struct({
  host: ShieldServerAlias,
  user: ShieldServerUser,
  hostKeys: Schema.optional(
    Schema.Array(SshHostPublicKey).pipe(Schema.minItems(1), Schema.maxItems(8)),
  ),
}).annotations(strict);
export type CloudMachineSshEndpoint = typeof CloudMachineSshEndpoint.Type;

/**
 * What the provider itself says the machine costs per hour, exactly as it
 * reported it: the amount as the provider wrote it, its ISO 4217 currency,
 * and which provider record it came from. Octant shows it as reported and
 * never estimates, converts or totals it.
 */
export const CloudMachineHourlyCost = Schema.Struct({
  amount: Schema.String.pipe(Schema.pattern(/^\d{1,9}(\.\d{1,9})?$/)),
  currency: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/)),
  /** The provider record the figure came from, such as its price list for the size. */
  source: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(120),
    Schema.filter((value) => !/[\u0000-\u001f]/.test(value)),
  ),
}).annotations(strict);
export type CloudMachineHourlyCost = typeof CloudMachineHourlyCost.Type;

/** The provider's machine as a target plugin reports it; decoded before it is believed. */
export const CloudMachineDescription = Schema.Struct({
  providerMachineId: boundedToken(256),
  state: CloudMachineState,
  endpoint: Schema.optional(CloudMachineSshEndpoint),
  /** Absent when the provider reports no price for this machine; never filled in by Octant. */
  costPerHour: Schema.optional(CloudMachineHourlyCost),
}).annotations(strict);
export type CloudMachineDescription = typeof CloudMachineDescription.Type;
export const decodeCloudMachineDescription = Schema.decodeUnknownOption(CloudMachineDescription);

/**
 * Where a machine's creation stands. `creating` is journaled before the
 * provider is asked, so a machine that was paid for is never unrecorded;
 * `creation-uncertain` means the provider's answer never arrived or could not
 * be read, and a machine may exist that the person must check for themselves.
 */
export const CloudMachineLifecycle = Schema.Literal(
  "creating",
  "created",
  "creation-refused",
  "creation-uncertain",
  "destroyed",
);
export type CloudMachineLifecycle = typeof CloudMachineLifecycle.Type;

export const CloudMachine = Schema.Struct({
  id: AggregateId,
  targetId: CloudMachineTargetId,
  name: ServerProjectName,
  recipe: CloudMachineRecipe,
  credentialReference: CloudCredentialReference,
  folder: ServerFolderPath,
  mode: Schema.optional(ServerProjectMode),
  requestedAt: UtcTimestamp,
  lifecycle: CloudMachineLifecycle,
  providerMachineId: Schema.optional(boundedToken(256)),
  state: Schema.optional(CloudMachineState),
  stateObservedAt: Schema.optional(UtcTimestamp),
  endpoint: Schema.optional(CloudMachineSshEndpoint),
  /** The provider's last reported hourly cost and when it was read. */
  costPerHour: Schema.optional(
    Schema.Struct({ ...CloudMachineHourlyCost.fields, observedAt: UtcTimestamp }).annotations(
      strict,
    ),
  ),
  serverId: Schema.optional(AggregateId),
  projectId: Schema.optional(ProjectId),
  detail: Schema.optional(Schema.String.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type CloudMachine = typeof CloudMachine.Type;

/** Only a person at a local window acts on a cloud machine. */
const localWindow = Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict);

export const CloudMachineCreationRequestedPayload = Schema.Struct({
  machine: Schema.Struct({
    id: AggregateId,
    targetId: CloudMachineTargetId,
    name: ServerProjectName,
    recipe: CloudMachineRecipe,
    credentialReference: CloudCredentialReference,
    folder: ServerFolderPath,
    mode: Schema.optional(ServerProjectMode),
    requestedAt: UtcTimestamp,
  }).annotations(strict),
  principal: localWindow,
}).annotations(strict);
export type CloudMachineCreationRequestedPayload = typeof CloudMachineCreationRequestedPayload.Type;

export const CloudMachineCreatedPayload = Schema.Struct({
  machineId: AggregateId,
  machine: CloudMachineDescription,
  observedAt: UtcTimestamp,
}).annotations(strict);

export const CloudMachineCreationEndedPayload = Schema.Struct({
  machineId: AggregateId,
  outcome: Schema.Literal("refused", "uncertain"),
  detail: Schema.String.pipe(Schema.maxLength(512)),
}).annotations(strict);

export const CloudMachineProjectBoundPayload = Schema.Struct({
  machineId: AggregateId,
  serverId: AggregateId,
  projectId: ProjectId,
  principal: localWindow,
}).annotations(strict);

export const CloudMachineStateChangedPayload = Schema.Struct({
  machineId: AggregateId,
  /** `destroy` is a destroy the provider is still finishing; `observe` is a refresh. */
  act: Schema.Literal("suspend", "resume", "destroy", "observe"),
  state: CloudMachineState,
  observedAt: UtcTimestamp,
  /** Present only when the provider reported a cost with this answer. */
  costPerHour: Schema.optional(CloudMachineHourlyCost),
  principal: localWindow,
}).annotations(strict);

export const CloudMachineDestroyedPayload = Schema.Struct({
  machineId: AggregateId,
  state: CloudMachineState,
  observedAt: UtcTimestamp,
  principal: localWindow,
}).annotations(strict);

/** A target the plugin host offers now: installed, trusted and enabled. */
export const CloudMachineTargetEntry = Schema.Struct({
  targetId: CloudMachineTargetId,
  displayName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
}).annotations(strict);
export type CloudMachineTargetEntry = typeof CloudMachineTargetEntry.Type;

export const CloudMachinesView = Schema.Struct({
  targets: Schema.Array(CloudMachineTargetEntry),
  machines: Schema.Array(CloudMachine).pipe(
    Schema.maxItems(MAX_CLOUD_MACHINES + MAX_SETTLED_CLOUD_MACHINES_SHOWN),
  ),
}).annotations(strict);
export type CloudMachinesView = typeof CloudMachinesView.Type;

export const CloudMachinesCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-cloud-machine"),
    targetId: CloudMachineTargetId,
    name: ServerProjectName,
    recipe: CloudMachineRecipe,
    credentialReference: CloudCredentialReference,
    folder: ServerFolderPath,
    mode: Schema.optional(ServerProjectMode),
  }).annotations(strict),
  /** Registers and binds the machine again after a binding that was refused. */
  Schema.Struct({
    kind: Schema.Literal("bind-cloud-machine-project"),
    machineId: AggregateId,
  }).annotations(strict),
  /** Reads where the machine stands from its provider and records it. */
  Schema.Struct({
    kind: Schema.Literal("refresh-cloud-machine"),
    machineId: AggregateId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("suspend-cloud-machine"),
    machineId: AggregateId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("resume-cloud-machine"),
    machineId: AggregateId,
  }).annotations(strict),
  /** Asks for the one confirmation a destroy needs; changes nothing. */
  Schema.Struct({
    kind: Schema.Literal("request-cloud-machine-destroy"),
    machineId: AggregateId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("destroy-cloud-machine"),
    machineId: AggregateId,
    confirmation: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  }).annotations(strict),
);
export type CloudMachinesCommand = typeof CloudMachinesCommand.Type;
export const decodeCloudMachinesCommand = Schema.decodeUnknownSync(CloudMachinesCommand);

export const CloudMachinesRefusalReason = Schema.Literal(
  "needs-person",
  "needs-local-window",
  "target-not-offered",
  "credential-unavailable",
  "too-many-machines",
  "machine-not-found",
  "machine-busy",
  "machine-not-running",
  "machine-not-suspended",
  "confirmation-required",
  "provider-refused",
  "provider-failed",
  "binding-refused",
  "unavailable",
);
export type CloudMachinesRefusalReason = typeof CloudMachinesRefusalReason.Type;

export const CloudMachinesCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("cloud-machines-updated"),
    view: CloudMachinesView,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cloud-machine-destroy-confirmation"),
    machineId: AggregateId,
    name: ServerProjectName,
    confirmation: Schema.String,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cloud-machines-refused"),
    reason: CloudMachinesRefusalReason,
    message: Schema.String,
  }).annotations(strict),
);
export type CloudMachinesCommandResult = typeof CloudMachinesCommandResult.Type;
