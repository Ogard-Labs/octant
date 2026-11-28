/**
 * Code and Work Projects bound to a folder on one of the person's registered servers.
 * Canonical: docs/design/server-projects.md.
 *
 * A server Project lives in its own catalog, never in the local Project
 * catalog, so nothing that reads a local Project's folder can be handed a
 * path on a server. Payloads name a registered server and a folder there; they
 * never carry a key, a key path, or SSH configuration.
 */

import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeCheckoutId, CodeRepositoryId } from "./code";
import { AggregateId, AggregateVersion, UtcTimestamp } from "./events";
import {
  BindingRevisionId,
  ProjectId,
  ProjectActions,
  WorkProjectDeveloperTools,
} from "./projects";
import { RemoteServerGrantId } from "./remoteServerGrants";
import { ShieldServerAlias, ShieldServerUser } from "./shieldServers";

export const SERVER_PROJECTS_AGGREGATE = "server-projects";
/** The catalog's one aggregate id: every server Project lives in the person's account list. */
export const SERVER_PROJECTS_AGGREGATE_ID = "5e7e0000-0000-4000-8000-000000000001";
export const SERVER_PROJECTS_EVENT_NAMES = {
  bound: "server-projects.bound@1",
  renamed: "server-projects.renamed@1",
  removed: "server-projects.removed@1",
  actionsReplaced: "server-projects.actions-replaced@1",
  developerToolsChanged: "server-projects.work-developer-tools-changed@1",
} as const;
export const SERVER_PROJECTS_PREVIEW_OUTCOME_V1 = "server-projects.preview-outcome@1" as const;
export const SERVER_PROJECTS_EVENT_NAMES_V2 = {
  bound: "server-projects.bound@2",
  renamed: "server-projects.renamed@2",
  removed: "server-projects.removed@2",
  actionsReplaced: "server-projects.actions-replaced@2",
  developerToolsChanged: "server-projects.work-developer-tools-changed@2",
  previewOutcome: "server-projects.preview-outcome@2",
} as const;

/**
 * Pending removals of thread attachment folders copied onto a registered server
 * (`~/.octant/thread-attachments/<threadId>/`). Kept in an aggregate of its own
 * so a thread purge never erases an owed remote cleanup before the server is
 * reached again.
 */
export const SERVER_ATTACHMENT_CLEANUP_AGGREGATE = "server-attachment-cleanup";
export const SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES = {
  pending: "server-attachment-cleanup.pending@1",
  settled: "server-attachment-cleanup.settled@1",
} as const;

/**
 * A single safe path segment under `~/.octant/thread-attachments/` on a server:
 * alphanumeric start, no slashes, no `..`, no whitespace or shell syntax.
 */
export const ServerAttachmentThreadId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Schema.makeFilter((id) => !id.includes("..")),
);
export type ServerAttachmentThreadId = typeof ServerAttachmentThreadId.Type;

export const ServerAttachmentCleanupPendingPayload = Schema.Struct({
  serverId: AggregateId,
  alias: ShieldServerAlias,
  user: ShieldServerUser,
  projectId: ProjectId,
  threadId: ServerAttachmentThreadId,
  queuedAt: UtcTimestamp,
});
export type ServerAttachmentCleanupPendingPayload =
  typeof ServerAttachmentCleanupPendingPayload.Type;

export const ServerAttachmentCleanupSettledPayload = Schema.Struct({
  serverId: AggregateId,
  projectId: ProjectId,
  threadId: ServerAttachmentThreadId,
  settledAt: UtcTimestamp,
});
export type ServerAttachmentCleanupSettledPayload =
  typeof ServerAttachmentCleanupSettledPayload.Type;

export const decodeServerAttachmentThreadId = Schema.decodeUnknownSync(
  ServerAttachmentThreadId,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerAttachmentCleanupPendingPayload = Schema.decodeUnknownSync(
  ServerAttachmentCleanupPendingPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerAttachmentCleanupSettledPayload = Schema.decodeUnknownSync(
  ServerAttachmentCleanupSettledPayload,
  STRICT_DECODE_OPTIONS,
);

export const MAX_SERVER_PROJECTS = 64;
export const MAX_SERVER_FOLDER_LENGTH = 1_024;

/** An absolute folder path on the server, as its own shell resolves it. */
export const ServerFolderPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SERVER_FOLDER_LENGTH),
  Schema.makeFilter(
    (path) => path.startsWith("/") && !path.includes("\u0000") && !/[\r\n]/.test(path),
  ),
);

export const ServerProjectName = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120));

/**
 * The mode a server Project's threads are in. Absent is Code, the only mode
 * the first catalog had, so a Code Project's record stays exactly what it was
 * and an older build never reads a Work Project as Code: it cannot decode one.
 */
export const ServerProjectMode = Schema.Literal("work");

export const ServerProject = Schema.Struct({
  id: ProjectId,
  name: ServerProjectName,
  /** The registered server (`shield-servers`) the folder is on. */
  serverId: AggregateId,
  /** The folder's real path on the server, resolved when it was bound. */
  folder: ServerFolderPath,
  boundAt: UtcTimestamp,
  mode: Schema.optional(ServerProjectMode),
  actions: Schema.optional(ProjectActions),
  /** Revision of this Project's saved list, independent of another catalog edit. */
  actionsVersion: Schema.optional(AggregateVersion),
  developerTools: Schema.optional(WorkProjectDeveloperTools),
});
export type ServerProject = typeof ServerProject.Type;

/**
 * Version 1 records name only a local window; version 2 widens `principal` to
 * also name a device the host's own person paired, with its credential
 * generation so the pairing survives re-pairing under a new key.
 */
const localWindow = Schema.Struct({ kind: Schema.Literal("local-window") });
export const ServerProjectEventPrincipalV2 = Schema.Union([
  localWindow,
  Schema.Struct({
    kind: Schema.Literal("person-paired-device"),
    credentialGeneration: PositiveInt,
  }),
]);
export type ServerProjectEventPrincipalV2 = typeof ServerProjectEventPrincipalV2.Type;

export const ServerProjectBoundPayload = Schema.Struct({
  project: ServerProject,
  principal: localWindow,
});
export type ServerProjectBoundPayload = typeof ServerProjectBoundPayload.Type;

export const ServerProjectBoundPayloadV2 = Schema.Struct({
  project: ServerProject,
  principal: ServerProjectEventPrincipalV2,
});
export type ServerProjectBoundPayloadV2 = typeof ServerProjectBoundPayloadV2.Type;

export const ServerProjectRenamedPayload = Schema.Struct({
  projectId: ProjectId,
  name: ServerProjectName,
  principal: localWindow,
});
export type ServerProjectRenamedPayload = typeof ServerProjectRenamedPayload.Type;

export const ServerProjectRenamedPayloadV2 = Schema.Struct({
  projectId: ProjectId,
  name: ServerProjectName,
  principal: ServerProjectEventPrincipalV2,
});
export type ServerProjectRenamedPayloadV2 = typeof ServerProjectRenamedPayloadV2.Type;

export const ServerProjectRemovedPayload = Schema.Struct({
  projectId: ProjectId,
  principal: localWindow,
});
export type ServerProjectRemovedPayload = typeof ServerProjectRemovedPayload.Type;

export const ServerProjectRemovedPayloadV2 = Schema.Struct({
  projectId: ProjectId,
  principal: ServerProjectEventPrincipalV2,
});
export type ServerProjectRemovedPayloadV2 = typeof ServerProjectRemovedPayloadV2.Type;

export const ServerProjectActionsReplacedPayload = Schema.Struct({
  projectId: ProjectId,
  actions: ProjectActions,
  actionsVersion: AggregateVersion,
  principal: localWindow,
});
export type ServerProjectActionsReplacedPayload = typeof ServerProjectActionsReplacedPayload.Type;
export const decodeServerProjectActionsReplacedPayload = Schema.decodeUnknownSync(
  ServerProjectActionsReplacedPayload,
  STRICT_DECODE_OPTIONS,
);
export const ServerProjectActionsReplacedPayloadV2 = Schema.Struct({
  projectId: ProjectId,
  actions: ProjectActions,
  actionsVersion: AggregateVersion,
  principal: ServerProjectEventPrincipalV2,
});
export type ServerProjectActionsReplacedPayloadV2 =
  typeof ServerProjectActionsReplacedPayloadV2.Type;
export const decodeServerProjectActionsReplacedPayloadV2 = Schema.decodeUnknownSync(
  ServerProjectActionsReplacedPayloadV2,
  STRICT_DECODE_OPTIONS,
);
export const ServerWorkDeveloperToolsChangedPayload = Schema.Struct({
  projectId: ProjectId,
  developerTools: WorkProjectDeveloperTools,
  principal: localWindow,
});
export const decodeServerWorkDeveloperToolsChangedPayload = Schema.decodeUnknownSync(
  ServerWorkDeveloperToolsChangedPayload,
  STRICT_DECODE_OPTIONS,
);
export const ServerWorkDeveloperToolsChangedPayloadV2 = Schema.Struct({
  projectId: ProjectId,
  developerTools: WorkProjectDeveloperTools,
  principal: ServerProjectEventPrincipalV2,
});
export type ServerWorkDeveloperToolsChangedPayloadV2 =
  typeof ServerWorkDeveloperToolsChangedPayloadV2.Type;
export const decodeServerWorkDeveloperToolsChangedPayloadV2 = Schema.decodeUnknownSync(
  ServerWorkDeveloperToolsChangedPayloadV2,
  STRICT_DECODE_OPTIONS,
);

/**
 * A machine's state as its cloud provider last reported it, normalized by the
 * target plugin. Octant shows this and never infers a state it did not read.
 * Canonical: docs/design/server-projects.md § Machines in the person's cloud account.
 */
export const CloudMachineState = Schema.Literals([
  "provisioning",
  "running",
  "suspending",
  "suspended",
  "resuming",
  "destroying",
  "destroyed",
  "unknown",
]);
export type CloudMachineState = typeof CloudMachineState.Type;

/** The cloud machine behind a server Project, as the catalog shows it. */
export const ServerProjectCloudMachine = Schema.Struct({
  machineId: AggregateId,
  targetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  state: CloudMachineState,
  stateObservedAt: UtcTimestamp,
});
export type ServerProjectCloudMachine = typeof ServerProjectCloudMachine.Type;

/**
 * The binding a Code Project on a server derives from its id, server, and
 * folder: the Project's own folder checkout, which a routine there binds.
 */
export const ServerProjectCodeBinding = Schema.Struct({
  bindingRevisionId: BindingRevisionId,
  repositoryId: CodeRepositoryId,
  checkoutId: CodeCheckoutId,
});
export type ServerProjectCodeBinding = typeof ServerProjectCodeBinding.Type;

/**
 * A server Project as the catalog shows it. A Work Project also names the
 * binding its threads are created against, and a Code Project its own folder
 * checkout, both of which the host derives from the Project; a Project on a
 * machine Octant created in the person's cloud account names that machine and
 * its last reported state. Nothing about any of them is journaled on the Project.
 */
export const ServerProjectEntry = Schema.Struct({
  ...ServerProject.fields,
  workBindingRevisionId: Schema.optional(BindingRevisionId),
  codeBinding: Schema.optional(ServerProjectCodeBinding),
  cloudMachine: Schema.optional(ServerProjectCloudMachine),
});
export type ServerProjectEntry = typeof ServerProjectEntry.Type;

export const ServerProjectsView = Schema.Struct({
  projects: Schema.Array(ServerProjectEntry).check(Schema.isMaxLength(MAX_SERVER_PROJECTS)),
});
export type ServerProjectsView = typeof ServerProjectsView.Type;

export const ServerProjectsCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set-server-work-developer-tools"),
    projectId: ProjectId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-server-project-actions"),
    projectId: ProjectId,
    expectedVersion: AggregateVersion,
    actions: ProjectActions,
  }),
  Schema.Struct({
    kind: Schema.Literal("bind-server-project"),
    name: ServerProjectName,
    serverId: AggregateId,
    folder: ServerFolderPath,
    mode: Schema.optional(ServerProjectMode),
  }),
  Schema.Struct({
    kind: Schema.Literal("rename-server-project"),
    projectId: ProjectId,
    name: ServerProjectName,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-server-project"),
    projectId: ProjectId,
  }),
]);
export type ServerProjectsCommand = typeof ServerProjectsCommand.Type;

export const ServerProjectsRefusalReason = Schema.Literals([
  "needs-person",
  "needs-local-window",
  "server-not-registered",
  "server-unreachable",
  "folder-not-found",
  "project-not-found",
  "too-many-projects",
  "actions-changed",
  "unavailable",
]);
export type ServerProjectsRefusalReason = typeof ServerProjectsRefusalReason.Type;

export const ServerProjectsCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("server-projects-updated"),
    view: ServerProjectsView,
    /** Returned when removing a Project could not reach its server to remove attached files left there. */
    notice: Schema.optional(NonEmptyTrimmedString),
  }),
  Schema.Struct({
    kind: Schema.Literal("server-projects-refused"),
    reason: ServerProjectsRefusalReason,
    message: Schema.String,
  }),
]);
export type ServerProjectsCommandResult = typeof ServerProjectsCommandResult.Type;

export const decodeServerProjectsCommand = Schema.decodeUnknownSync(
  ServerProjectsCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectsView = Schema.decodeUnknownSync(
  ServerProjectsView,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectsCommandResult = Schema.decodeUnknownSync(
  ServerProjectsCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectBoundPayload = Schema.decodeUnknownSync(
  ServerProjectBoundPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectBoundPayloadV2 = Schema.decodeUnknownSync(
  ServerProjectBoundPayloadV2,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectRenamedPayload = Schema.decodeUnknownSync(
  ServerProjectRenamedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectRenamedPayloadV2 = Schema.decodeUnknownSync(
  ServerProjectRenamedPayloadV2,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectRemovedPayload = Schema.decodeUnknownSync(
  ServerProjectRemovedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerProjectRemovedPayloadV2 = Schema.decodeUnknownSync(
  ServerProjectRemovedPayloadV2,
  STRICT_DECODE_OPTIONS,
);

/** Person-operated preview of one selected port on the registered server's loopback. */
export const ServerPreviewCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start"),
    projectId: ProjectId,
    remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    localPort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  }),
  Schema.Struct({ kind: Schema.Literals(["stop", "reconnect"]), projectId: ProjectId }),
]);
export type ServerPreviewCommand = typeof ServerPreviewCommand.Type;
export const ServerPreviewView = Schema.Struct({
  projectId: Schema.String,
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  /** Loopback port for a local window's preview; 0 when served to a paired device via the relay. */
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  endpoint: Schema.String,
  status: Schema.Literals(["listening", "lost", "stopped", "revoked"]),
  /** Present when the host serves this preview through `/api/server-proxy/<grantId>/`. */
  grantId: Schema.optional(RemoteServerGrantId),
}).check(
  Schema.makeFilter((view) =>
    view.localPort === 0
      ? view.grantId !== undefined && view.endpoint === `/api/server-proxy/${view.grantId}/`
      : view.grantId === undefined && view.endpoint === `http://127.0.0.1:${view.localPort}`,
  ),
);
export type ServerPreviewView = typeof ServerPreviewView.Type;
export const ServerPreviewOutcomePayloadV1 = Schema.Struct({
  projectId: Schema.String,
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  endpoint: Schema.String,
  status: Schema.Literals(["listening", "lost", "stopped", "revoked"]),
  owner: Schema.String,
});
export type ServerPreviewOutcomePayloadV1 = typeof ServerPreviewOutcomePayloadV1.Type;
export const ServerPreviewOutcomePayloadV2 = Schema.Struct({
  projectId: Schema.String,
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  endpoint: Schema.String,
  status: Schema.Literals(["listening", "lost", "stopped", "revoked"]),
  grantId: Schema.optional(RemoteServerGrantId),
  owner: Schema.String,
  principal: ServerProjectEventPrincipalV2,
});
export type ServerPreviewOutcomePayloadV2 = typeof ServerPreviewOutcomePayloadV2.Type;
export const ServerPreviewResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tunnel"), view: ServerPreviewView }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);
export type ServerPreviewResult = typeof ServerPreviewResult.Type;

/**
 * Person-operated forward of one TCP port on the registered server's loopback
 * to this computer's `127.0.0.1`, as raw TCP for tools that are not a browser
 * (a database client, a debugger). Only a window on this computer starts one.
 */
export const ServerPortForwardCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start"),
    projectId: ProjectId,
    remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  Schema.Struct({ kind: Schema.Literal("stop"), projectId: ProjectId }),
]);
export type ServerPortForwardCommand = typeof ServerPortForwardCommand.Type;
export const ServerPortForwardView = Schema.Struct({
  projectId: Schema.String,
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  /** The port on this computer's `127.0.0.1`: the server's number when it was free. */
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  status: Schema.Literals(["listening", "lost", "stopped", "revoked"]),
});
export type ServerPortForwardView = typeof ServerPortForwardView.Type;
export const ServerPortForwardResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("forward"), view: ServerPortForwardView }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);
export type ServerPortForwardResult = typeof ServerPortForwardResult.Type;

export const SERVER_PROJECTS_PORT_FORWARD_OPENED = "server-projects.port-forward-opened@1" as const;
export const SERVER_PROJECTS_PORT_FORWARD_CLOSED = "server-projects.port-forward-closed@1" as const;
/** Journaled with the Project and the ports, never the server's address or what travels. */
export const ServerPortForwardOpenedPayload = Schema.Struct({
  projectId: Schema.String,
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export type ServerPortForwardOpenedPayload = typeof ServerPortForwardOpenedPayload.Type;
/**
 * - `expired`: its hour ran out.
 * - `revoked`: the window that opened it closed, or the Project's binding changed.
 * - `lost`: an SSH stream to the server failed.
 * - `host-stopped`: the host shut down, or a starting host found it left open.
 */
export const ServerPortForwardCloseReason = Schema.Literals([
  "stopped",
  "expired",
  "revoked",
  "lost",
  "host-stopped",
]);
export type ServerPortForwardCloseReason = typeof ServerPortForwardCloseReason.Type;
export const ServerPortForwardClosedPayload = Schema.Struct({
  projectId: Schema.String,
  remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  localPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  reason: ServerPortForwardCloseReason,
});
export type ServerPortForwardClosedPayload = typeof ServerPortForwardClosedPayload.Type;
export const decodeServerPortForwardOpenedPayload = Schema.decodeUnknownSync(
  ServerPortForwardOpenedPayload,
  STRICT_DECODE_OPTIONS,
);
export const decodeServerPortForwardClosedPayload = Schema.decodeUnknownSync(
  ServerPortForwardClosedPayload,
  STRICT_DECODE_OPTIONS,
);

/**
 * The TCP ports the SSH login serves from a server Project's folder, read on
 * the server: the port and the process's short name, never a command line.
 */
export const ServerProjectListenerList = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("listed"),
    listeners: Schema.Array(
      Schema.Struct({
        port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
        processName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
        /** Whether the socket answers on 127.0.0.1, where the preview's forward connects. */
        loopbackReachable: Schema.Boolean,
      }),
    ).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    message: Schema.String.check(Schema.isMaxLength(512)),
  }),
]);
export type ServerProjectListenerList = typeof ServerProjectListenerList.Type;
