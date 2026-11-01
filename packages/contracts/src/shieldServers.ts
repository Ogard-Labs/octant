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
import { AggregateId, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SHIELD_SERVERS_AGGREGATE = "shield-servers";
/** The account list's aggregate id; a Project's own list lives under the Project's id. */
export const SHIELD_SERVERS_AGGREGATE_ID = "5e7e0000-0000-4000-8000-000000000000";
export const SHIELD_SERVERS_EVENT_NAMES = {
  serverSet: "shield-servers.server-set@1",
  serverRemoved: "shield-servers.server-removed@1",
  projectServersSet: "shield-servers.project-servers-set@1",
  projectOverrideCleared: "shield-servers.project-override-cleared@1",
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
export const ShieldServerProfile = Schema.Literal("read-only", "operate", "admin");
export type ShieldServerProfile = typeof ShieldServerProfile.Type;

/** A `Host` alias as an SSH config names it: no spaces, patterns, or leading dash. */
export const ShieldServerAlias = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(253),
  Schema.pattern(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/),
);
/** A login name on the server. */
export const ShieldServerUser = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(32),
  Schema.pattern(/^[A-Za-z_][A-Za-z0-9._-]*$/),
);
/** A command the person described as a deploy, run on the server exactly as written. */
export const ShieldServerDeployCommand = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_SHIELD_DEPLOY_COMMAND_LENGTH),
);
/** An absolute path to the person's notes for the server, read as context and never as authority. */
export const ShieldServerRunbookPath = Schema.String.pipe(
  Schema.minLength(2),
  Schema.maxLength(MAX_SHIELD_RUNBOOK_PATH_LENGTH),
  Schema.filter((path) => path.startsWith("/") && !path.includes("\u0000")),
);

/**
 * How a confined command signs in to the server: through the person's own SSH
 * agent (the default, and what a server registered before the choice means),
 * or with a key Octant made for this server and keeps in its credential
 * broker, which signs the login and never hands the key out.
 */
export const ShieldServerSignIn = Schema.Literal("ssh-agent", "octant-key");
export type ShieldServerSignIn = typeof ShieldServerSignIn.Type;

/** The public line of a key Octant keeps, as `authorized_keys` takes it. */
export const ShieldServerPublicKey = Schema.String.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/),
);

export const ShieldServerFields = Schema.Struct({
  alias: ShieldServerAlias,
  user: ShieldServerUser,
  profile: ShieldServerProfile,
  deployCommands: Schema.Array(ShieldServerDeployCommand).pipe(
    Schema.maxItems(MAX_SHIELD_SERVER_DEPLOY_COMMANDS),
  ),
  runbookPath: Schema.optional(ShieldServerRunbookPath),
  signIn: Schema.optional(ShieldServerSignIn),
}).annotations(strict);
export type ShieldServerFields = typeof ShieldServerFields.Type;

export const ShieldServer = Schema.Struct({
  serverId: AggregateId,
  ...ShieldServerFields.fields,
}).annotations(strict);
export type ShieldServer = typeof ShieldServer.Type;

/** Only a person at a local window changes the registry. */
const localWindow = Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict);

/** One server registered or changed, as a whole record that replaces the one before. */
export const ShieldServerSetPayload = Schema.Struct({
  server: ShieldServer,
  principal: localWindow,
}).annotations(strict);
export type ShieldServerSetPayload = typeof ShieldServerSetPayload.Type;

export const ShieldServerRemovedPayload = Schema.Struct({
  serverId: AggregateId,
  principal: localWindow,
}).annotations(strict);
export type ShieldServerRemovedPayload = typeof ShieldServerRemovedPayload.Type;

/**
 * A Project's own server list, whole: it replaces the account list for that
 * Project's threads until it is cleared.
 */
export const ShieldProjectServersSetPayload = Schema.Struct({
  projectId: AggregateId,
  servers: Schema.Array(ShieldServer).pipe(Schema.maxItems(MAX_SHIELD_SERVERS)),
  principal: localWindow,
}).annotations(strict);
export type ShieldProjectServersSetPayload = typeof ShieldProjectServersSetPayload.Type;

/** A Project goes back to the account list. */
export const ShieldProjectServersClearedPayload = Schema.Struct({
  projectId: AggregateId,
  principal: localWindow,
}).annotations(strict);
export type ShieldProjectServersClearedPayload = typeof ShieldProjectServersClearedPayload.Type;

/** How a remote command ended, as the shell that ran it saw it. */
export const ShieldRemoteCommandStatus = Schema.Literal(
  "ran",
  "timed-out",
  "cancelled",
  "unavailable",
);
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
  command: Schema.String.pipe(Schema.maxLength(MAX_SHIELD_REMOTE_COMMAND_LENGTH)),
  status: ShieldRemoteCommandStatus,
  exitCode: Schema.optional(Schema.Int),
  ranAt: UtcTimestamp,
}).annotations(strict);
export type ShieldRemoteCommandRanPayload = typeof ShieldRemoteCommandRanPayload.Type;

/**
 * Settings › Servers: the account list, and when a Project is asked about,
 * its own list (`null` while it follows the account list), and whether the
 * person's SSH agent is there to use.
 */
export const ShieldServersView = Schema.Struct({
  servers: Schema.Array(ShieldServer).pipe(Schema.maxItems(MAX_SHIELD_SERVERS)),
  project: Schema.optional(
    Schema.Struct({
      projectId: AggregateId,
      override: Schema.NullOr(Schema.Array(ShieldServer).pipe(Schema.maxItems(MAX_SHIELD_SERVERS))),
    }).annotations(strict),
  ),
  sshAgent: Schema.Literal("available", "missing"),
}).annotations(strict);
export type ShieldServersView = typeof ShieldServersView.Type;

export const ShieldServersCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("register-server"),
    server: ShieldServerFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-server"),
    serverId: AggregateId,
    server: ShieldServerFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-server"),
    serverId: AggregateId,
  }).annotations(strict),
  /** Gives a Project its own whole list, which replaces the account list there. */
  Schema.Struct({
    kind: Schema.Literal("set-project-servers"),
    projectId: AggregateId,
    servers: Schema.Array(ShieldServerFields).pipe(Schema.maxItems(MAX_SHIELD_SERVERS)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear-project-override"),
    projectId: AggregateId,
  }).annotations(strict),
  /**
   * The public line of the key Octant keeps for a server that signs in with
   * one, making the key the first time, for the person to add to the
   * server's `authorized_keys`.
   */
  Schema.Struct({
    kind: Schema.Literal("show-server-key"),
    serverId: AggregateId,
  }).annotations(strict),
);
export type ShieldServersCommand = typeof ShieldServersCommand.Type;

export const ShieldServersRefusalReason = Schema.Literal(
  "needs-local-window",
  "duplicate-alias",
  "invalid-runbook-path",
  "invalid-deploy-command",
  "server-not-found",
  "too-many-servers",
  "project-not-found",
  "signs-in-with-agent",
  "key-unavailable",
  "unavailable",
);
export type ShieldServersRefusalReason = typeof ShieldServersRefusalReason.Type;

export const ShieldServersCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("shield-servers-updated"),
    view: ShieldServersView,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("shield-server-key"),
    serverId: AggregateId,
    publicKey: ShieldServerPublicKey,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("shield-servers-refused"),
    reason: ShieldServersRefusalReason,
    message: Schema.String,
  }).annotations(strict),
);
export type ShieldServersCommandResult = typeof ShieldServersCommandResult.Type;

export const decodeShieldServersCommand = Schema.decodeUnknownSync(ShieldServersCommand);
export const decodeShieldServersView = Schema.decodeUnknownSync(ShieldServersView);
export const decodeShieldServerSetPayload = Schema.decodeUnknownSync(ShieldServerSetPayload);
export const decodeShieldServerRemovedPayload = Schema.decodeUnknownSync(
  ShieldServerRemovedPayload,
);
export const decodeShieldProjectServersSetPayload = Schema.decodeUnknownSync(
  ShieldProjectServersSetPayload,
);
export const decodeShieldProjectServersClearedPayload = Schema.decodeUnknownSync(
  ShieldProjectServersClearedPayload,
);
export const decodeShieldRemoteCommandRanPayload = Schema.decodeUnknownSync(
  ShieldRemoteCommandRanPayload,
);
