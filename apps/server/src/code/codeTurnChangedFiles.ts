import {
  decodeCodeRelativePath,
  MAX_CODE_TURN_CHANGED_PATHS,
  type CodeCheckoutId,
  type CodeTurnChangedFile,
  type CodeTurnChangedFiles,
} from "@octant/contracts";
import type { GitTreeChange } from "./gitObservationPort";

/**
 * Turn what Git reported between two captures into the record a turn keeps.
 *
 * A name out of a tree is untrusted like any filesystem name. One the confined
 * relative-path contract refuses is dropped and marks the record truncated,
 * never normalized into a path a later read would resolve somewhere else.
 *
 * Nothing changed and nothing lost is no record at all, so a turn that only
 * answered a question journals nothing extra.
 */
export function turnChangedFiles(
  changes: ReadonlyArray<GitTreeChange>,
): CodeTurnChangedFiles | undefined {
  if (changes.length === 0) return undefined;
  const accepted: CodeTurnChangedFile[] = [];
  for (const change of changes) {
    let path: CodeTurnChangedFile["path"];
    try {
      path = decodeCodeRelativePath(change.path);
    } catch {
      continue;
    }
    accepted.push({
      path,
      insertions: change.insertions,
      deletions: change.deletions,
      ...(change.binary ? { binary: true as const } : {}),
    });
  }
  return {
    files: accepted.slice(0, MAX_CODE_TURN_CHANGED_PATHS),
    total: changes.length,
    truncated: accepted.length < changes.length || accepted.length > MAX_CODE_TURN_CHANGED_PATHS,
  };
}

export interface RepositoryTreeChanges {
  readonly repository: string;
  readonly checkoutId: CodeCheckoutId;
  readonly changes: ReadonlyArray<GitTreeChange>;
}

/**
 * Combine tree changes observed across several repositories in a multi-repo
 * Code thread, tagging each entry with its repository label and checkout id
 * while keeping the single global path bound (`MAX_CODE_TURN_CHANGED_PATHS`).
 */
export function turnChangedFilesAcrossRepositories(
  groups: ReadonlyArray<RepositoryTreeChanges>,
): CodeTurnChangedFiles | undefined {
  let total = 0;
  const accepted: CodeTurnChangedFile[] = [];
  for (const group of groups) {
    total += group.changes.length;
    for (const change of group.changes) {
      let path: CodeTurnChangedFile["path"];
      try {
        path = decodeCodeRelativePath(change.path);
      } catch {
        continue;
      }
      accepted.push({
        path,
        insertions: change.insertions,
        deletions: change.deletions,
        ...(change.binary ? { binary: true as const } : {}),
        repository: group.repository,
        checkoutId: group.checkoutId,
      });
    }
  }
  if (total === 0) return undefined;
  return {
    files: accepted.slice(0, MAX_CODE_TURN_CHANGED_PATHS),
    total,
    truncated: accepted.length < total || accepted.length > MAX_CODE_TURN_CHANGED_PATHS,
  };
}
