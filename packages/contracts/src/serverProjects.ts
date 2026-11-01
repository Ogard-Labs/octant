/**
 * Code Projects bound to a folder on one of the person's registered servers.
 * Canonical: docs/design/server-projects.md.
 *
 * A server Project lives in its own catalog, never in the local Project
 * catalog, so nothing that reads a local Project's folder can be handed a
 * path on a server. Payloads name a registered server and a folder there; they
 * never carry a key, a key path, or SSH configuration.
 */

import { Schema } from "effect";
import { AggregateId, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SERVER_PROJECTS_AGGREGATE = "server-projects";
/** The catalog's one aggregate id: every server Project lives in the person's account list. */
export const SERVER_PROJECTS_AGGREGATE_ID = "5e7e0000-0000-4000-8000-000000000001";
export const SERVER_PROJECTS_EVENT_NAMES = {
  bound: "server-projects.bound@1",
  renamed: "server-projects.renamed@1",
  removed: "server-projects.removed@1",
} as const;

export const MAX_SERVER_PROJECTS = 64;
export const MAX_SERVER_FOLDER_LENGTH = 1_024;

/** An absolute folder path on the server, as its own shell resolves it. */
export const ServerFolderPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_SERVER_FOLDER_LENGTH),
  Schema.filter((path) => path.startsWith("/") && !path.includes("\u0000") && !/[\r\n]/.test(path)),
);

export const ServerProjectName = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120));

export const ServerProject = Schema.Struct({
  id: ProjectId,
  name: ServerProjectName,
  /** The registered server (`shield-servers`) the folder is on. */
  serverId: AggregateId,
  /** The folder's real path on the server, resolved when it was bound. */
  folder: ServerFolderPath,
  boundAt: UtcTimestamp,
}).annotations(strict);
export type ServerProject = typeof ServerProject.Type;

/** Only a person at a local window changes the catalog. */
const localWindow = Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict);

export const ServerProjectBoundPayload = Schema.Struct({
  project: ServerProject,
  principal: localWindow,
}).annotations(strict);
export type ServerProjectBoundPayload = typeof ServerProjectBoundPayload.Type;

export const ServerProjectRenamedPayload = Schema.Struct({
  projectId: ProjectId,
  name: ServerProjectName,
  principal: localWindow,
}).annotations(strict);
export type ServerProjectRenamedPayload = typeof ServerProjectRenamedPayload.Type;

export const ServerProjectRemovedPayload = Schema.Struct({
  projectId: ProjectId,
  principal: localWindow,
}).annotations(strict);
export type ServerProjectRemovedPayload = typeof ServerProjectRemovedPayload.Type;

export const ServerProjectsView = Schema.Struct({
  projects: Schema.Array(ServerProject).pipe(Schema.maxItems(MAX_SERVER_PROJECTS)),
}).annotations(strict);
export type ServerProjectsView = typeof ServerProjectsView.Type;

export const ServerProjectsCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("bind-server-project"),
    name: ServerProjectName,
    serverId: AggregateId,
    folder: ServerFolderPath,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rename-server-project"),
    projectId: ProjectId,
    name: ServerProjectName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("remove-server-project"),
    projectId: ProjectId,
  }).annotations(strict),
);
export type ServerProjectsCommand = typeof ServerProjectsCommand.Type;

export const ServerProjectsRefusalReason = Schema.Literal(
  "needs-local-window",
  "server-not-registered",
  "server-unreachable",
  "folder-not-found",
  "project-not-found",
  "too-many-projects",
  "unavailable",
);
export type ServerProjectsRefusalReason = typeof ServerProjectsRefusalReason.Type;

export const ServerProjectsCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("server-projects-updated"),
    view: ServerProjectsView,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("server-projects-refused"),
    reason: ServerProjectsRefusalReason,
    message: Schema.String,
  }).annotations(strict),
);
export type ServerProjectsCommandResult = typeof ServerProjectsCommandResult.Type;

export const decodeServerProjectsCommand = Schema.decodeUnknownSync(ServerProjectsCommand);
export const decodeServerProjectsView = Schema.decodeUnknownSync(ServerProjectsView);
export const decodeServerProjectsCommandResult = Schema.decodeUnknownSync(
  ServerProjectsCommandResult,
);
export const decodeServerProjectBoundPayload = Schema.decodeUnknownSync(ServerProjectBoundPayload);
export const decodeServerProjectRenamedPayload = Schema.decodeUnknownSync(
  ServerProjectRenamedPayload,
);
export const decodeServerProjectRemovedPayload = Schema.decodeUnknownSync(
  ServerProjectRemovedPayload,
);
