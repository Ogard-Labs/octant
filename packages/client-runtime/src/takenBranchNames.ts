import {
  decodeCodeCommand,
  type CodeCommand,
  type CodeCommandResult,
  type ProjectId,
} from "@octant/contracts";

/**
 * The names a new worktree's branch must not collide with, read only when the
 * person chose a prefix: a branch or tag named like it blocks every name below.
 * A host that cannot say leaves the name to the host's own check.
 */
export async function takenBranchNames(
  execute: (command: CodeCommand) => Promise<CodeCommandResult | undefined>,
  projectId: ProjectId,
  prefix: string | undefined,
): Promise<ReadonlyArray<string>> {
  if (prefix === undefined) return [];
  try {
    const result = await execute(
      decodeCodeCommand({ kind: "list-code-worktree-branch-names", projectId }),
    );
    return result?.kind === "worktree-branch-names-listed" ? result.names : [];
  } catch {
    return [];
  }
}
