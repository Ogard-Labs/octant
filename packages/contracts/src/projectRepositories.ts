import { Schema } from "effect";
import { CodeCheckoutHead, CodeCheckoutId, CodeRepositoryId } from "./code";
import { BindingRevisionId, ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } } as const;

export const MAX_DISCOVERED_PROJECT_REPOSITORIES = 16;
export const MAX_DISCOVERED_WORKSPACE_FOLDERS = 32;
export const MAX_DISCOVERED_REPOSITORY_SUBMODULES = 64;

/**
 * A submodule declared in a repository's committed `.gitmodules`.
 * Submodules are listed for visibility; they do not get independent checkouts
 * or worktrees of their own.
 */
export const ProjectRepositorySubmodule = Schema.Struct({
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  initialized: Schema.Boolean,
}).annotations(strict);
export type ProjectRepositorySubmodule = typeof ProjectRepositorySubmodule.Type;

/**
 * One Git repository discovered inside a Code Project's granted folders (main
 * folder or an approved extra folder). Discovery is read-only and grants no
 * new filesystem authority.
 */
export const DiscoveredProjectRepository = Schema.Struct({
  repositoryId: CodeRepositoryId,
  checkoutId: CodeCheckoutId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  canonicalRoot: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  source: Schema.Literal("main-folder", "nested", "extra-folder"),
  head: CodeCheckoutHead,
  submodules: Schema.optional(
    Schema.Array(ProjectRepositorySubmodule).pipe(
      Schema.maxItems(MAX_DISCOVERED_REPOSITORY_SUBMODULES),
    ),
  ),
}).annotations(strict);
export type DiscoveredProjectRepository = typeof DiscoveredProjectRepository.Type;

/**
 * A folder named by a `.code-workspace` file inside the Project's main folder.
 * A workspace file is data only: a folder sitting outside the Project's
 * granted folders is offered through the existing extra-folder picker receipt
 * flow and judged by `extraFolderRefusal`.
 */
export const DiscoveredWorkspaceFolder = Schema.Struct({
  workspaceFile: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  status: Schema.Literal("available", "already-included", "refused"),
  reason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
}).annotations(strict);
export type DiscoveredWorkspaceFolder = typeof DiscoveredWorkspaceFolder.Type;

export const ProjectRepositoriesList = Schema.Struct({
  kind: Schema.Literal("project-repositories"),
  projectId: ProjectId,
  bindingRevisionId: BindingRevisionId,
  repositories: Schema.Array(DiscoveredProjectRepository).pipe(
    Schema.maxItems(MAX_DISCOVERED_PROJECT_REPOSITORIES),
  ),
  truncated: Schema.Boolean,
  workspaceFolders: Schema.Array(DiscoveredWorkspaceFolder).pipe(
    Schema.maxItems(MAX_DISCOVERED_WORKSPACE_FOLDERS),
  ),
}).annotations(strict);
export type ProjectRepositoriesList = typeof ProjectRepositoriesList.Type;
export const decodeProjectRepositoriesList = Schema.decodeUnknownSync(ProjectRepositoriesList);
