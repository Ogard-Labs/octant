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
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateId, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import {
  CloudMachineState,
  ServerFolderPath,
  ServerProjectEventPrincipalV2,
  ServerProjectMode,
  ServerProjectName,
} from "./serverProjects";
import { ShieldServerAlias, ShieldServerUser } from "./shieldServers";

export const CLOUD_MACHINES_AGGREGATE = "cloud-machines";
export const CLOUD_MACHINES_EVENT_NAMES = {
  creationRequested: "cloud-machines.creation-requested@1",
  created: "cloud-machines.created@1",
  creationEnded: "cloud-machines.creation-ended@1",
  projectBound: "cloud-machines.project-bound@1",
  stateChanged: "cloud-machines.state-changed@1",
  destroyed: "cloud-machines.destroyed@1",
} as const;
export const CLOUD_MACHINES_EVENT_NAMES_V2 = {
  creationRequested: "cloud-machines.creation-requested@2",
  projectBound: "cloud-machines.project-bound@2",
  stateChanged: "cloud-machines.state-changed@2",
  destroyed: "cloud-machines.destroyed@2",
} as const;

/** Machines that may hold something in the person's account at once. */
export const MAX_CLOUD_MACHINES = 32;
/** Destroyed machines and refused creations the view still lists, most recent first kept. */
export const MAX_SETTLED_CLOUD_MACHINES_SHOWN = 16;
export const MAX_CLOUD_MACHINE_SETUP_SCRIPT_BYTES = 16_384;

const boundedToken = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.makeFilter((value) => !/\s/.test(value) && !value.includes("\u0000")),
  );

/** A target as the plugin host names it: the plugin and its component. */
export const CloudMachineTargetId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._/-]*$/),
);
export type CloudMachineTargetId = typeof CloudMachineTargetId.Type;

/** The credential broker's reference for the cloud account; never its value. */
export const CloudCredentialReference = GuidString;
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
    Schema.String.check(
      Schema.isMaxLength(MAX_CLOUD_MACHINE_SETUP_SCRIPT_BYTES),
      Schema.makeFilter((script) => !script.includes("\u0000")),
    ),
  ),
});
export type CloudMachineRecipe = typeof CloudMachineRecipe.Type;
export const decodeCloudMachineRecipe = Schema.decodeUnknownSync(
  CloudMachineRecipe,
  STRICT_DECODE_OPTIONS,
);

/**
 * One SSH host public key as the provider reports it, in the `known_hosts`
 * form after the host pattern: the key type, one space, and the base64 key.
 * Only OpenSSH's current host key types are accepted, and nothing else may
 * ride on the line, because the host writes it into a known hosts file.
 */
export const SshHostPublicKey = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.isPattern(
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
    Schema.Array(SshHostPublicKey).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  ),
});
export type CloudMachineSshEndpoint = typeof CloudMachineSshEndpoint.Type;

/**
 * What the provider itself says the machine costs per hour, exactly as it
 * reported it: the amount as the provider wrote it, its ISO 4217 currency,
 * and which provider record it came from. Octant shows it as reported and
 * never estimates, converts or totals it.
 */
export const CloudMachineHourlyCost = Schema.Struct({
  amount: Schema.String.check(Schema.isPattern(/^\d{1,9}(\.\d{1,9})?$/)),
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  /** The provider record the figure came from, such as its price list for the size. */
  source: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(120),
    Schema.makeFilter((value) => !/[\u0000-\u001f]/.test(value)),
  ),
});
export type CloudMachineHourlyCost = typeof CloudMachineHourlyCost.Type;

/** The provider's machine as a target plugin reports it; decoded before it is believed. */
export const CloudMachineDescription = Schema.Struct({
  providerMachineId: boundedToken(256),
  state: CloudMachineState,
  endpoint: Schema.optional(CloudMachineSshEndpoint),
  /** Absent when the provider reports no price for this machine; never filled in by Octant. */
  costPerHour: Schema.optional(CloudMachineHourlyCost),
});
export type CloudMachineDescription = typeof CloudMachineDescription.Type;
export const decodeCloudMachineDescription = Schema.decodeUnknownOption(
  CloudMachineDescription,
  STRICT_DECODE_OPTIONS,
);

/**
 * Where a machine's creation stands. `creating` is journaled before the
 * provider is asked, so a machine that was paid for is never unrecorded;
 * `creation-uncertain` means the provider's answer never arrived or could not
 * be read, and a machine may exist that the person must check for themselves.
 */
export const CloudMachineLifecycle = Schema.Literals([
  "creating",
  "created",
  "creation-refused",
  "creation-uncertain",
  "destroyed",
]);
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
    Schema.Struct({ ...CloudMachineHourlyCost.fields, observedAt: UtcTimestamp }),
  ),
  serverId: Schema.optional(AggregateId),
  projectId: Schema.optional(ProjectId),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type CloudMachine = typeof CloudMachine.Type;

/** Version 1 records name only a local window; version 2 also names a person-paired device. */
const localWindow = Schema.Struct({ kind: Schema.Literal("local-window") });
export const CloudMachineEventPrincipalV2 = ServerProjectEventPrincipalV2;
export type CloudMachineEventPrincipalV2 = ServerProjectEventPrincipalV2;

const CloudMachineCreationRequestedMachine = Schema.Struct({
  id: AggregateId,
  targetId: CloudMachineTargetId,
  name: ServerProjectName,
  recipe: CloudMachineRecipe,
  credentialReference: CloudCredentialReference,
  folder: ServerFolderPath,
  mode: Schema.optional(ServerProjectMode),
  requestedAt: UtcTimestamp,
});

export const CloudMachineCreationRequestedPayload = Schema.Struct({
  machine: CloudMachineCreationRequestedMachine,
  principal: localWindow,
});
export type CloudMachineCreationRequestedPayload = typeof CloudMachineCreationRequestedPayload.Type;

export const CloudMachineCreationRequestedPayloadV2 = Schema.Struct({
  machine: CloudMachineCreationRequestedMachine,
  principal: CloudMachineEventPrincipalV2,
});
export type CloudMachineCreationRequestedPayloadV2 =
  typeof CloudMachineCreationRequestedPayloadV2.Type;

export const CloudMachineCreatedPayload = Schema.Struct({
  machineId: AggregateId,
  machine: CloudMachineDescription,
  observedAt: UtcTimestamp,
});

export const CloudMachineCreationEndedPayload = Schema.Struct({
  machineId: AggregateId,
  outcome: Schema.Literals(["refused", "uncertain"]),
  detail: Schema.String.check(Schema.isMaxLength(512)),
});

export const CloudMachineProjectBoundPayload = Schema.Struct({
  machineId: AggregateId,
  serverId: AggregateId,
  projectId: ProjectId,
  principal: localWindow,
});

export const CloudMachineProjectBoundPayloadV2 = Schema.Struct({
  machineId: AggregateId,
  serverId: AggregateId,
  projectId: ProjectId,
  principal: CloudMachineEventPrincipalV2,
});

export const CloudMachineStateChangedPayload = Schema.Struct({
  machineId: AggregateId,
  /** `destroy` is a destroy the provider is still finishing; `observe` is a refresh. */
  act: Schema.Literals(["suspend", "resume", "destroy", "observe"]),
  state: CloudMachineState,
  observedAt: UtcTimestamp,
  /** Present only when the provider reported a cost with this answer. */
  costPerHour: Schema.optional(CloudMachineHourlyCost),
  principal: localWindow,
});

export const CloudMachineStateChangedPayloadV2 = Schema.Struct({
  machineId: AggregateId,
  /** `destroy` is a destroy the provider is still finishing; `observe` is a refresh. */
  act: Schema.Literals(["suspend", "resume", "destroy", "observe"]),
  state: CloudMachineState,
  observedAt: UtcTimestamp,
  /** Present only when the provider reported a cost with this answer. */
  costPerHour: Schema.optional(CloudMachineHourlyCost),
  principal: CloudMachineEventPrincipalV2,
});

export const CloudMachineDestroyedPayload = Schema.Struct({
  machineId: AggregateId,
  state: CloudMachineState,
  observedAt: UtcTimestamp,
  principal: localWindow,
});

export const CloudMachineDestroyedPayloadV2 = Schema.Struct({
  machineId: AggregateId,
  state: CloudMachineState,
  observedAt: UtcTimestamp,
  principal: CloudMachineEventPrincipalV2,
});

/** A target the plugin host offers now: installed, trusted and enabled. */
export const CloudMachineTargetEntry = Schema.Struct({
  targetId: CloudMachineTargetId,
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});
export type CloudMachineTargetEntry = typeof CloudMachineTargetEntry.Type;

export const CloudMachinesView = Schema.Struct({
  targets: Schema.Array(CloudMachineTargetEntry),
  machines: Schema.Array(CloudMachine).check(
    Schema.isMaxLength(MAX_CLOUD_MACHINES + MAX_SETTLED_CLOUD_MACHINES_SHOWN),
  ),
});
export type CloudMachinesView = typeof CloudMachinesView.Type;

export const CloudMachinesCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create-cloud-machine"),
    targetId: CloudMachineTargetId,
    name: ServerProjectName,
    recipe: CloudMachineRecipe,
    credentialReference: CloudCredentialReference,
    folder: ServerFolderPath,
    mode: Schema.optional(ServerProjectMode),
  }),
  Schema.Struct({
    kind: Schema.Literal("bind-cloud-machine-project"),
    machineId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("refresh-cloud-machine"),
    machineId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("suspend-cloud-machine"),
    machineId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("resume-cloud-machine"),
    machineId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("request-cloud-machine-destroy"),
    machineId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("destroy-cloud-machine"),
    machineId: AggregateId,
    confirmation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
]);
export type CloudMachinesCommand = typeof CloudMachinesCommand.Type;
export const decodeCloudMachinesCommand = Schema.decodeUnknownSync(
  CloudMachinesCommand,
  STRICT_DECODE_OPTIONS,
);

export const CloudMachinesRefusalReason = Schema.Literals([
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
]);
export type CloudMachinesRefusalReason = typeof CloudMachinesRefusalReason.Type;

export const CloudMachinesCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cloud-machines-updated"),
    view: CloudMachinesView,
  }),
  Schema.Struct({
    kind: Schema.Literal("cloud-machine-destroy-confirmation"),
    machineId: AggregateId,
    name: ServerProjectName,
    confirmation: Schema.String,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("cloud-machines-refused"),
    reason: CloudMachinesRefusalReason,
    message: Schema.String,
  }),
]);
export type CloudMachinesCommandResult = typeof CloudMachinesCommandResult.Type;
