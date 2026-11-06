import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  decodeProjectWorkingFolderId,
  type ApprovedWorkingFolder,
  type BoundProject,
  type ProjectWorkingFolderId,
} from "@octant/contracts";

function folders(project: BoundProject) {
  const revision = project.bindingHistory.at(-1)?.revisionId;
  if (revision === undefined) throw new Error("Bound Project has no binding revision.");
  return [
    { root: project.binding.canonicalRoot, kind: "main" as const, addedAt: String(revision) },
    ...(project.extraFolders ?? []).map((folder) => ({
      root: folder.canonicalRoot,
      kind: "extra" as const,
      addedAt: String(folder.addedRevision ?? folder.addedAt),
    })),
  ].map((folder) => ({
    ...folder,
    id: decodeProjectWorkingFolderId(
      `folder_${createHash("sha256")
        .update(JSON.stringify([project.id, revision, folder.kind, folder.root, folder.addedAt]))
        .digest("hex")}`,
    ),
  }));
}
export function approvedWorkingFolderChoices(
  project: BoundProject,
): ReadonlyArray<ApprovedWorkingFolder> {
  return folders(project).map((folder) => ({
    id: folder.id,
    kind: folder.kind,
    label: folder.kind === "main" ? "Main folder" : basename(folder.root),
  }));
}

/** An explicit binding/add identity never falls back to the thread checkout. */
export function approvedWorkingFolderRoot(
  project: BoundProject,
  id: ProjectWorkingFolderId | undefined,
  checkoutRoot = project.binding.canonicalRoot,
): string | undefined {
  if (id === undefined) return checkoutRoot;
  const selected = folders(project).find((folder) => String(folder.id) === String(id));
  return selected?.kind === "main" ? checkoutRoot : selected?.root;
}
