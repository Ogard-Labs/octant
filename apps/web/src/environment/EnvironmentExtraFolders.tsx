import type { ProjectExtraFolder } from "@octant/contracts/projects";
import { FolderPlus } from "lucide-react";
import { homeRelativePath } from "../lib/homeRelativePath";
import { EnvironmentGroup } from "./EnvironmentGroup";

/**
 * The extra folders the thread's Project reaches beside its main folder, as one
 * Environment row that opens into a read-only list. They are changed on the
 * Project's page, so a thread only shows what its agent can see. Drawn only
 * when the Project has any.
 */
export function EnvironmentExtraFolders(props: {
  readonly folders: ReadonlyArray<ProjectExtraFolder> | undefined;
}) {
  const folders = props.folders ?? [];
  if (folders.length === 0) return null;
  return (
    <EnvironmentGroup icon={FolderPlus} summary={String(folders.length)} title="Extra folders">
      <ul className="environment-extra-folders">
        {folders.map((folder) => (
          <li key={folder.canonicalRoot} title={folder.canonicalRoot}>
            <span aria-hidden="true">{homeRelativePath(folder.canonicalRoot)}</span>
            <span className="sr-only">{folder.canonicalRoot}</span>
          </li>
        ))}
      </ul>
    </EnvironmentGroup>
  );
}
