/**
 * Octant Shield's server registry and the record of remote commands.
 * Canonical: docs/architecture.md § Octant Shield (servers over SSH).
 *
 * A person registers their own servers: a host alias from their SSH config, a
 * user, and an action profile. SSH to a registered server passes Shield's
 * rules within that profile; every remote command a thread runs is journaled
 * with its host and exit status. Payloads never carry a private key, a key
 * path, or a command's output; strict decoding refuses any field that is not
 * named here.
 */

import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateId, UtcTimestamp } from "./events";
import { HubMemberId } from "./hubAndSpokes";

export const SHIELD_SERVERS_AGGREGATE = "shield-servers";
/** The account list's aggregate id; a Project's own list lives under the Project's id. */
export const SHIELD_SERVERS_AGGREGATE_ID = "5e7e0000-0000-4000-8000-000000000000";
export const SHIELD_SERVERS_EVENT_NAMES = {
  serverSet: "shield-servers.server-set@1",
  serverRemoved: "shield-servers.server-removed@1",
  projectServersSet: "shield-servers.project-servers-set@1",
  projectOverrideCleared: "shield-servers.project-override-cleared@1",
  memberInstallRequested: "shield-servers.member-install-requested@1",
  memberInstallStepRecorded: "shield-servers.member-install-step@1",
  /** Names the drain the person chose: stop now, or wait up to some minutes. */
  memberUpdateRequested: "shield-servers.member-update-requested@2",
  /** Written before waiting for running turns was built; read back, never written. */
  memberUpdateRequestedV1: "shield-servers.member-update-requested@1",
  memberUpdateStepRecorded: "shield-servers.member-update-step@1",
  memberRemovalRequested: "shield-servers.member-removal-requested@1",
  memberRemovalStepRecorded: "shield-servers.member-removal-step@1",
} as const;

/** Remote commands are journaled per thread, on the thread's own aggregate id. */
export const SHIELD_REMOTE_COMMANDS_AGGREGATE = "shield-remote-commands";
export const SHIELD_REMOTE_COMMAND_EVENT_NAMES = {
  ran: "shield-remote-commands.ran@1",
} as const;

export const MAX_SHIELD_SERVERS = 64;
export const MAX_SHIELD_SERVER_DEPLOY_COMMANDS = 16;
export const MAX_SHIELD_DEPLOY_COMMAND_LENGTH = 512;
export const MAX_SHIELD_RUNBOOK_PATH_LENGTH = 1_024;
/** A journaled remote command is cut to this length after credential-shaped text is redacted. */
export const MAX_SHIELD_REMOTE_COMMAND_LENGTH = 2_048;

/**
 * What Shield lets a thread do on a server without asking. Each profile
 * includes the one before: Read-only reads status, logs, disk, processes and
 * services; Operate adds service restarts, package updates, and the deploys
 * the person described; Admin adds config edits. Lock-out and destructive
 * actions go to the person at every profile.
 */
export const ShieldServerProfile = Schema.Literals(["read-only", "operate", "admin"]);
export type ShieldServerProfile = typeof ShieldServerProfile.Type;

/** A `Host` alias as an SSH config names it: no spaces, patterns, or leading dash. */
export const ShieldServerAlias = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(253),
  Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/),
);
/** A login name on the server. */
export const ShieldServerUser = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9._-]*$/),
);
/** A command the person described as a deploy, run on the server exactly as written. */
export const ShieldServerDeployCommand = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SHIELD_DEPLOY_COMMAND_LENGTH),
);
/** An absolute path to the person's notes for the server, read as context and never as authority. */
export const ShieldServerRunbookPath = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(MAX_SHIELD_RUNBOOK_PATH_LENGTH),
  Schema.makeFilter((path) => path.startsWith("/") && !path.includes("\u0000")),
);

/**
 * How a confined command signs in to the server: through the person's own SSH
 * agent (the default, and what a server registered before the choice means),
 * or with a key Octant made for this server and keeps in its credential
 * broker, which signs the login and never hands the key out.
 */
export const ShieldServerSignIn = Schema.Literals(["ssh-agent", "octant-key"]);
export type ShieldServerSignIn = typeof ShieldServerSignIn.Type;

/** The public line of a key Octant keeps, as `authorized_keys` takes it. */
export const ShieldServerPublicKey = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/),
);

export const ShieldServerFields = Schema.Struct({
  alias: ShieldServerAlias,
  user: ShieldServerUser,
  profile: ShieldServerProfile,
  deployCommands: Schema.Array(ShieldServerDeployCommand).check(
    Schema.isMaxLength(MAX_SHIELD_SERVER_DEPLOY_COMMANDS),
  ),
  runbookPath: Schema.optional(ShieldServerRunbookPath),
  signIn: Schema.optional(ShieldServerSignIn),
});
export type ShieldServerFields = typeof ShieldServerFields.Type;

export const ShieldServer = Schema.Struct({
  serverId: AggregateId,
  ...ShieldServerFields.fields,
});
export type ShieldServer = typeof ShieldServer.Type;

/**
 * Only the host's own person changes the registry: at a local window, or on a
 * device that person paired, whose id the event's actor names.
 */
const ShieldServerPerson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-window") }),
  Schema.Struct({ kind: Schema.Literal("person-paired-device") }),
]);

/** One server registered or changed, as a whole record that replaces the one before. */
export const ShieldServerSetPayload = Schema.Struct({
  server: ShieldServer,
  principal: ShieldServerPerson,
});
export type ShieldServerSetPayload = typeof ShieldServerSetPayload.Type;

export const ShieldServerRemovedPayload = Schema.Struct({
  serverId: AggregateId,
  principal: ShieldServerPerson,
});
export type ShieldServerRemovedPayload = typeof ShieldServerRemovedPayload.Type;

/**
 * A Project's own server list, whole: it replaces the account list for that
 * Project's threads until it is cleared.
 */
export const ShieldProjectServersSetPayload = Schema.Struct({
  projectId: AggregateId,
  servers: Schema.Array(ShieldServer).check(Schema.isMaxLength(MAX_SHIELD_SERVERS)),
  principal: ShieldServerPerson,
});
export type ShieldProjectServersSetPayload = typeof ShieldProjectServersSetPayload.Type;

/** A Project goes back to the account list. */
export const ShieldProjectServersClearedPayload = Schema.Struct({
  projectId: AggregateId,
  principal: ShieldServerPerson,
});
export type ShieldProjectServersClearedPayload = typeof ShieldProjectServersClearedPayload.Type;

/** How a remote command ended, as the shell that ran it saw it. */
export const ShieldRemoteCommandStatus = Schema.Literals([
  "ran",
  "timed-out",
  "cancelled",
  "unavailable",
]);
export type ShieldRemoteCommandStatus = typeof ShieldRemoteCommandStatus.Type;

/**
 * One `ssh` command a thread ran, with the host it named and how it ended.
 * The command is redacted and cut; its output is never journaled here (it
 * reaches the thread through the Watcher like any command's output).
 */
export const ShieldRemoteCommandRanPayload = Schema.Struct({
  threadId: AggregateId,
  /** The host the command names, absent when it names one only at run time (`ssh "$HOST"`) or not as an alias. */
  host: Schema.optional(ShieldServerAlias),
  /** The registered server the host named, when it is one. */
  serverId: Schema.optional(AggregateId),
  command: Schema.String.check(Schema.isMaxLength(MAX_SHIELD_REMOTE_COMMAND_LENGTH)),
  status: ShieldRemoteCommandStatus,
  exitCode: Schema.optional(Schema.Int),
  ranAt: UtcTimestamp,
});
export type ShieldRemoteCommandRanPayload = typeof ShieldRemoteCommandRanPayload.Type;

/**
 * Settings › Servers: the account list, and when a Project is asked about,
 * its own list (`null` while it follows the account list), and whether the
 * person's SSH agent is there to use.
 */
export const ShieldServersView = Schema.Struct({
  servers: Schema.Array(ShieldServer).check(Schema.isMaxLength(MAX_SHIELD_SERVERS)),
  project: Schema.optional(
    Schema.Struct({
      projectId: AggregateId,
      override: Schema.NullOr(
        Schema.Array(ShieldServer).check(Schema.isMaxLength(MAX_SHIELD_SERVERS)),
      ),
    }),
  ),
  sshAgent: Schema.Literals(["available", "missing"]),
});
export type ShieldServersView = typeof ShieldServersView.Type;

export const ShieldServersCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("register-server"),
    server: ShieldServerFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("change-server"),
    serverId: AggregateId,
    server: ShieldServerFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-server"),
    serverId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-project-servers"),
    projectId: AggregateId,
    servers: Schema.Array(ShieldServerFields).check(Schema.isMaxLength(MAX_SHIELD_SERVERS)),
  }),
  Schema.Struct({
    kind: Schema.Literal("clear-project-override"),
    projectId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("show-server-key"),
    serverId: AggregateId,
  }),
]);
export type ShieldServersCommand = typeof ShieldServersCommand.Type;

export const ShieldServersRefusalReason = Schema.Literals([
  "needs-local-window",
  "duplicate-alias",
  "invalid-runbook-path",
  "invalid-deploy-command",
  "server-not-found",
  "server-has-projects",
  "too-many-servers",
  "project-not-found",
  "signs-in-with-agent",
  "key-unavailable",
  "unavailable",
]);
export type ShieldServersRefusalReason = typeof ShieldServersRefusalReason.Type;

export const ShieldServersCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("shield-servers-updated"),
    view: ShieldServersView,
  }),
  Schema.Struct({
    kind: Schema.Literal("shield-server-key"),
    serverId: AggregateId,
    publicKey: ShieldServerPublicKey,
  }),
  Schema.Struct({
    kind: Schema.Literal("shield-servers-refused"),
    reason: ShieldServersRefusalReason,
    message: Schema.String,
  }),
]);
export type ShieldServersCommandResult = typeof ShieldServersCommandResult.Type;

/**
 * Making a registered server an Octant computer: the signed headless build
 * installed over SSH after the person confirms, started as a user service of
 * the login, listening on a private address, and joined to this computer's
 * hub. Canonical: docs/design/hub-and-spokes.md § Adding a computer over SSH.
 */
export const MemberInstallTarget = Schema.Literals(["darwin-arm64", "linux-x64", "linux-arm64"]);
export type MemberInstallTarget = typeof MemberInstallTarget.Type;

/** The steps in the order they run; a failed step stops every step after it. */
export const MEMBER_INSTALL_STEPS = [
  "copy",
  "verify",
  "install",
  "start",
  "listen",
  "join",
] as const;
export const MemberInstallStep = Schema.Literals(MEMBER_INSTALL_STEPS);
export type MemberInstallStep = typeof MemberInstallStep.Type;

/** Why a step failed, as a closed list: the journal never holds a server's own words. */
export const MemberInstallFailure = Schema.Literals([
  "server-unreachable",
  "digest-mismatch",
  "build-mismatch",
  "command-failed",
  "join-code-unavailable",
  "comparison-mismatch",
  "timed-out",
]);
export type MemberInstallFailure = typeof MemberInstallFailure.Type;

const MemberInstallReleaseRing = Schema.Literals(["stable", "preview", "candidate"]);
const MemberInstallVersion = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const MemberInstallAddress = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253));
const MemberInstallPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));

/**
 * The person confirmed the sheet. Journaled before anything runs on the
 * server, with the person or their paired device as the event's actor. It
 * names the build and the address, never a join code, ticket, or key.
 */
export const MemberInstallRequestedPayload = Schema.Struct({
  installId: AggregateId,
  serverId: AggregateId,
  target: MemberInstallTarget,
  artifactVersion: MemberInstallVersion,
  ring: MemberInstallReleaseRing,
  listenAddress: MemberInstallAddress,
  listenPort: MemberInstallPort,
  joins: Schema.Literal("hub"),
});
export type MemberInstallRequestedPayload = typeof MemberInstallRequestedPayload.Type;

/** How one step ended, journaled as it ends, with the same actor as the request. */
export const MemberInstallStepRecordedPayload = Schema.Struct({
  installId: AggregateId,
  serverId: AggregateId,
  step: MemberInstallStep,
  outcome: Schema.Literals(["succeeded", "failed"]),
  failure: Schema.optional(MemberInstallFailure),
  /**
   * On a succeeded join: the hub member the server became, read from the
   * roster right after the join this SSH connection approved. Removal acts on
   * this identity, never on whichever member holds the listener address later.
   */
  memberId: Schema.optional(HubMemberId),
});
export type MemberInstallStepRecordedPayload = typeof MemberInstallStepRecordedPayload.Type;

/** A private address the server reported, which the person may pick to listen on. */
export const MemberInstallAddressOption = Schema.Struct({
  address: MemberInstallAddress,
  network: Schema.Literals(["tailscale", "lan-private"]),
});
export type MemberInstallAddressOption = typeof MemberInstallAddressOption.Type;

/** What the sheet states before anything runs, every fact read now. */
export const MemberInstallPlan = Schema.Struct({
  planId: AggregateId,
  serverId: AggregateId,
  alias: ShieldServerAlias,
  user: ShieldServerUser,
  /** `uname -sm` as the server answered it over SSH. */
  system: Schema.String.check(Schema.isMaxLength(128)),
  target: MemberInstallTarget,
  artifactVersion: MemberInstallVersion,
  ring: MemberInstallReleaseRing,
  /** The ring's release signature and every file's digest checked on this computer. */
  signature: Schema.Literal("verified"),
  /** The login's own data folder; nothing outside it, and no sudo. */
  installRoot: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(1_024)),
  service: Schema.Literals(["systemd-user", "launchd-agent"]),
  /** Whether the server already starts the login's services with no one logged in. */
  startsAtBoot: Schema.Boolean,
  /** The one administrator command for starting at boot, for the person to run; absent when none applies. */
  bootCommand: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  addresses: Schema.Array(MemberInstallAddressOption).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  listenPort: MemberInstallPort,
  joins: Schema.Struct({
    kind: Schema.Literal("hub"),
    hubName: Schema.String.check(Schema.isMaxLength(128)),
  }),
});
export type MemberInstallPlan = typeof MemberInstallPlan.Type;

export const MemberInstallStepState = Schema.Struct({
  step: MemberInstallStep,
  state: Schema.Literals(["waiting", "running", "succeeded", "failed", "not-run"]),
  /** What to fix, for a failed step. Shown in the sheet; never journaled. */
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
});
export type MemberInstallStepState = typeof MemberInstallStepState.Type;

export const MemberInstallProgress = Schema.Struct({
  installId: AggregateId,
  serverId: AggregateId,
  state: Schema.Literals(["running", "joined", "failed"]),
  steps: Schema.Array(MemberInstallStepState).check(
    Schema.isMaxLength(MEMBER_INSTALL_STEPS.length),
  ),
});
export type MemberInstallProgress = typeof MemberInstallProgress.Type;

/**
 * Updating a member Octant installed over SSH, and removing Octant from it.
 * Canonical: docs/design/hub-and-spokes.md § Adding a computer over SSH.
 */

/** A server this computer made an Octant computer, as the journal holds it. */
export const MemberComputer = Schema.Struct({
  serverId: AggregateId,
  target: MemberInstallTarget,
  /** The version the last confirmed install or update left running. */
  artifactVersion: MemberInstallVersion,
  listenAddress: MemberInstallAddress,
  listenPort: MemberInstallPort,
  /** The hub member the join made it; absent for a join recorded without one. */
  memberId: Schema.optional(HubMemberId),
});
export type MemberComputer = typeof MemberComputer.Type;

/** The update's steps in the order they run; `roll-back` runs only after a failed swap or confirmation. */
export const MEMBER_UPDATE_STEPS = ["copy", "verify", "drain", "swap", "confirm"] as const;
export const MemberUpdateStep = Schema.Literals([...MEMBER_UPDATE_STEPS, "roll-back"]);
export type MemberUpdateStep = typeof MemberUpdateStep.Type;

/**
 * Why an update step failed, as a closed list. The last four are why the
 * confirmation refused the swapped build, and so why it was rolled back.
 */
export const MemberUpdateFailure = Schema.Literals([
  "server-unreachable",
  "digest-mismatch",
  "build-mismatch",
  "command-failed",
  "timed-out",
  "recovery-required",
  "rollback-unsafe",
  "health-check-failed",
  "hello-unproven",
  "version-mismatch",
  "protocol-not-covered",
]);
export type MemberUpdateFailure = typeof MemberUpdateFailure.Type;

/** The longest the person may have an update wait for running turns. */
export const MEMBER_UPDATE_MAX_WAIT_MINUTES = 60;

/**
 * How the member stops admitting turns before the swap, as the person chose.
 * Both first refuse new turns. `wait` lets running turns finish for up to
 * `minutes` and then stops the member; `stop-now` stops it at once. Either
 * way the member's owner stops gracefully, and the turns the stop cuts off
 * continue by themselves once it starts again.
 */
export const MemberUpdateDrain = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stop-now") }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    minutes: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MEMBER_UPDATE_MAX_WAIT_MINUTES }),
    ),
  }),
]);
export type MemberUpdateDrain = typeof MemberUpdateDrain.Type;
export const MemberUpdateDrainKind = Schema.Literals(["wait", "stop-now"]);
export type MemberUpdateDrainKind = typeof MemberUpdateDrainKind.Type;

/** The person confirmed an update. Journaled before anything runs on the server; it names builds, never a key. */
export const MemberUpdateRequestedPayload = Schema.Struct({
  updateId: AggregateId,
  serverId: AggregateId,
  target: MemberInstallTarget,
  fromVersion: MemberInstallVersion,
  toVersion: MemberInstallVersion,
  ring: MemberInstallReleaseRing,
  drain: MemberUpdateDrain,
});
export type MemberUpdateRequestedPayload = typeof MemberUpdateRequestedPayload.Type;

/** `shield-servers.member-update-requested@1`, whose only drain was stopping now. */
export const MemberUpdateRequestedPayloadV1 = Schema.Struct({
  ...MemberUpdateRequestedPayload.fields,
  drain: Schema.Literal("stop-now"),
});
export type MemberUpdateRequestedPayloadV1 = typeof MemberUpdateRequestedPayloadV1.Type;

export const MemberUpdateStepRecordedPayload = Schema.Struct({
  updateId: AggregateId,
  serverId: AggregateId,
  step: MemberUpdateStep,
  outcome: Schema.Literals(["succeeded", "failed"]),
  failure: Schema.optional(MemberUpdateFailure),
});
export type MemberUpdateStepRecordedPayload = typeof MemberUpdateStepRecordedPayload.Type;

export const MEMBER_REMOVAL_STEPS = ["leave", "stop", "delete"] as const;
export const MemberRemovalStep = Schema.Literals(MEMBER_REMOVAL_STEPS);
export type MemberRemovalStep = typeof MemberRemovalStep.Type;

export const MemberRemovalFailure = Schema.Literals([
  "server-unreachable",
  "command-failed",
  "timed-out",
]);
export type MemberRemovalFailure = typeof MemberRemovalFailure.Type;

/** The person confirmed removing Octant; `deleteData` is true only when they ticked it. */
export const MemberRemovalRequestedPayload = Schema.Struct({
  removalId: AggregateId,
  serverId: AggregateId,
  deleteData: Schema.Boolean,
});
export type MemberRemovalRequestedPayload = typeof MemberRemovalRequestedPayload.Type;

export const MemberRemovalStepRecordedPayload = Schema.Struct({
  removalId: AggregateId,
  serverId: AggregateId,
  step: MemberRemovalStep,
  outcome: Schema.Literals(["succeeded", "failed"]),
  failure: Schema.optional(MemberRemovalFailure),
});
export type MemberRemovalStepRecordedPayload = typeof MemberRemovalStepRecordedPayload.Type;

const MemberStepRunState = Schema.Literals([
  "waiting",
  "running",
  "succeeded",
  "failed",
  "not-run",
]);
const MemberStepMessage = Schema.String.check(Schema.isMaxLength(1_024));
const MemberInstallPath = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(1_024));

/**
 * Downloading the signed headless build for a server's target from this
 * computer's ring, when none suitable is on this computer: the ring's signed
 * listing, then the build's digest, then its own release signature, before it
 * is kept in the data folder's `headless-builds` folder. The sheet reads it
 * until it is ready, then reads its plan again.
 */
export const MemberBuildDownloadState = Schema.Literals([
  "downloading",
  "verifying",
  "ready",
  "refused",
]);
export type MemberBuildDownloadState = typeof MemberBuildDownloadState.Type;

/** Why a download kept nothing, as a closed list. */
export const MemberBuildDownloadRefusal = Schema.Literals([
  "unreachable",
  "no-release",
  "no-newer-release",
  "untrusted-listing",
  "digest-mismatch",
  "build-unverified",
]);
export type MemberBuildDownloadRefusal = typeof MemberBuildDownloadRefusal.Type;

export const MemberBuildDownload = Schema.Struct({
  downloadId: AggregateId,
  target: MemberInstallTarget,
  ring: MemberInstallReleaseRing,
  state: MemberBuildDownloadState,
  /** The version the signed listing names, once it is read. */
  version: Schema.optional(MemberInstallVersion),
  refusal: Schema.optional(MemberBuildDownloadRefusal),
  message: Schema.optional(MemberStepMessage),
});
export type MemberBuildDownload = typeof MemberBuildDownload.Type;

/** What the Update sheet states before anything runs, every fact read now. */
export const MemberUpdatePlan = Schema.Struct({
  planId: AggregateId,
  serverId: AggregateId,
  alias: ShieldServerAlias,
  user: ShieldServerUser,
  target: MemberInstallTarget,
  /** The version the server's `current` link names now. */
  fromVersion: MemberInstallVersion,
  toVersion: MemberInstallVersion,
  ring: MemberInstallReleaseRing,
  signature: Schema.Literal("verified"),
  installRoot: MemberInstallPath,
  /** The new build migrates the member's store; `octant server upgrade` takes a verified backup first. */
  storeMigration: Schema.Boolean,
  /** The ways to drain on offer, the one the sheet starts on first. */
  drains: Schema.Array(MemberUpdateDrainKind).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export type MemberUpdatePlan = typeof MemberUpdatePlan.Type;

export const MemberUpdateStepState = Schema.Struct({
  step: MemberUpdateStep,
  state: MemberStepRunState,
  message: Schema.optional(MemberStepMessage),
});
export type MemberUpdateStepState = typeof MemberUpdateStepState.Type;

export const MemberUpdateProgress = Schema.Struct({
  updateId: AggregateId,
  serverId: AggregateId,
  state: Schema.Literals(["running", "updated", "rolled-back", "failed"]),
  steps: Schema.Array(MemberUpdateStepState).check(
    Schema.isMaxLength(MEMBER_UPDATE_STEPS.length + 1),
  ),
  /** Why the swapped build was rolled back, when it was. */
  rollbackReason: Schema.optional(MemberUpdateFailure),
});
export type MemberUpdateProgress = typeof MemberUpdateProgress.Type;

/** What the Remove Octant sheet states before anything runs. */
export const MemberRemovalPlan = Schema.Struct({
  planId: AggregateId,
  serverId: AggregateId,
  alias: ShieldServerAlias,
  user: ShieldServerUser,
  installRoot: MemberInstallPath,
  /** The login's Octant data folder: kept unless the person ticks to delete it. */
  dataFolder: MemberInstallPath,
  service: Schema.Literals(["systemd-user", "launchd-agent"]),
});
export type MemberRemovalPlan = typeof MemberRemovalPlan.Type;

export const MemberRemovalStepState = Schema.Struct({
  step: MemberRemovalStep,
  state: MemberStepRunState,
  message: Schema.optional(MemberStepMessage),
});
export type MemberRemovalStepState = typeof MemberRemovalStepState.Type;

export const MemberRemovalProgress = Schema.Struct({
  removalId: AggregateId,
  serverId: AggregateId,
  state: Schema.Literals(["running", "removed", "failed"]),
  deleteData: Schema.Boolean,
  steps: Schema.Array(MemberRemovalStepState).check(
    Schema.isMaxLength(MEMBER_REMOVAL_STEPS.length),
  ),
});
export type MemberRemovalProgress = typeof MemberRemovalProgress.Type;

export const MemberInstallCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("prepare-member-install"),
    serverId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("confirm-member-install"),
    planId: AggregateId,
    listenAddress: MemberInstallAddress,
  }),
  Schema.Struct({
    kind: Schema.Literal("read-member-install"),
    installId: AggregateId,
  }),
  Schema.Struct({ kind: Schema.Literal("list-member-computers") }),
  Schema.Struct({
    kind: Schema.Literal("prepare-member-update"),
    serverId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("confirm-member-update"),
    planId: AggregateId,
    drain: MemberUpdateDrain,
  }),
  Schema.Struct({
    kind: Schema.Literal("read-member-update"),
    updateId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("prepare-member-removal"),
    serverId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("confirm-member-removal"),
    planId: AggregateId,
    deleteData: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("read-member-removal"),
    removalId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("read-member-build-download"),
    downloadId: AggregateId,
  }),
  Schema.Struct({
    kind: Schema.Literal("leave-member-build-download"),
    downloadId: AggregateId,
  }),
]);
export type MemberInstallCommand = typeof MemberInstallCommand.Type;

export const MemberInstallRefusalReason = Schema.Literals([
  "not-the-person",
  "server-not-found",
  "server-unreachable",
  "unsupported-system",
  "no-private-address",
  "no-build",
  "build-unverified",
  "no-hub",
  "not-the-hub",
  "hub-unavailable",
  "plan-expired",
  "address-not-offered",
  "install-not-found",
  "already-installing",
  "unavailable",
  "not-a-member",
  "no-newer-build",
  "update-not-found",
  "removal-not-found",
  "download-not-found",
]);
export type MemberInstallRefusalReason = typeof MemberInstallRefusalReason.Type;

export const MemberInstallResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("member-install-plan"),
    plan: MemberInstallPlan,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-install-progress"),
    progress: MemberInstallProgress,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-computers"),
    members: Schema.Array(MemberComputer).check(Schema.isMaxLength(MAX_SHIELD_SERVERS)),
  }),
  Schema.Struct({
    kind: Schema.Literal("member-update-plan"),
    plan: MemberUpdatePlan,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-update-progress"),
    progress: MemberUpdateProgress,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-removal-plan"),
    plan: MemberRemovalPlan,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-removal-progress"),
    progress: MemberRemovalProgress,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-build-download"),
    download: MemberBuildDownload,
  }),
  Schema.Struct({
    kind: Schema.Literal("member-install-refused"),
    reason: MemberInstallRefusalReason,
    message: Schema.String,
  }),
]);
export type MemberInstallResult = typeof MemberInstallResult.Type;

export const decodeMemberInstallCommand = Schema.decodeUnknownSync(
  MemberInstallCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberInstallRequestedPayload = Schema.decodeUnknownSync(
  MemberInstallRequestedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberInstallStepRecordedPayload = Schema.decodeUnknownSync(
  MemberInstallStepRecordedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberUpdateRequestedPayload = Schema.decodeUnknownSync(
  MemberUpdateRequestedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberUpdateRequestedPayloadV1 = Schema.decodeUnknownSync(
  MemberUpdateRequestedPayloadV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberUpdateStepRecordedPayload = Schema.decodeUnknownSync(
  MemberUpdateStepRecordedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberRemovalRequestedPayload = Schema.decodeUnknownSync(
  MemberRemovalRequestedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeMemberRemovalStepRecordedPayload = Schema.decodeUnknownSync(
  MemberRemovalStepRecordedPayload,
  STRICT_DECODE_OPTIONS,
);

export const decodeShieldServersCommand = Schema.decodeUnknownSync(
  ShieldServersCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeShieldServersView = Schema.decodeUnknownSync(
  ShieldServersView,
  STRICT_DECODE_OPTIONS,
);
export const decodeShieldServerSetPayload = Schema.decodeUnknownSync(
  ShieldServerSetPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeShieldServerRemovedPayload = Schema.decodeUnknownSync(
  ShieldServerRemovedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeShieldProjectServersSetPayload = Schema.decodeUnknownSync(
  ShieldProjectServersSetPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeShieldProjectServersClearedPayload = Schema.decodeUnknownSync(
  ShieldProjectServersClearedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeShieldRemoteCommandRanPayload = Schema.decodeUnknownSync(
  ShieldRemoteCommandRanPayload,
  STRICT_DECODE_OPTIONS,
);
