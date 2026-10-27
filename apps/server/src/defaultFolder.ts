import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DefaultFolder, type ShellSettings } from "@octant/contracts";
import { Schema } from "effect";
import {
  isInsideHomeDirectory,
  realPathThroughExistingAncestors,
} from "./canvas/artifactMirrorFilePort";

const decodeDefaultFolder = Schema.decodeUnknownSync(DefaultFolder);

/**
 * The folder Octant uses for anything nobody gave a home. Work and Code
 * threads started without a Project bind a subfolder of it, and artifact
 * files mirror under it unless the mirror names another place.
 */
export const DEFAULT_FOLDER_WORK_SUBFOLDER = "Work";
export const DEFAULT_FOLDER_CODE_SUBFOLDER = "Code";
export const DEFAULT_FOLDER_ARTIFACTS_SUBFOLDER = "Artifacts";

/**
 * The top of home rather than Documents: macOS asks before an app reads
 * Documents, and a folder Octant creates on its own should not cost a
 * privacy prompt on a fresh host. A folder the settings already store,
 * including the earlier `~/Documents/Octant`, stays where it is.
 */
export function hostDefaultFolder(home: string = homedir()): DefaultFolder {
  return decodeDefaultFolder(join(home, "Octant"));
}

export function effectiveDefaultFolder(
  settings: Pick<ShellSettings, "defaultFolder">,
  home: string = homedir(),
): string {
  return settings.defaultFolder ?? hostDefaultFolder(home);
}

export function defaultFolderProjectRoot(folder: string, projectType: "work" | "code"): string {
  return join(
    folder,
    projectType === "work" ? DEFAULT_FOLDER_WORK_SUBFOLDER : DEFAULT_FOLDER_CODE_SUBFOLDER,
  );
}

export type DefaultFolderVerdict =
  | { readonly status: "accepted"; readonly folder: DefaultFolder }
  | { readonly status: "refused"; readonly message: string };

/**
 * A folder the person named can be anywhere, so it is governed the way the
 * artifact mirror's global folder is (`docs/decisions/0029`): until the
 * standing access-outside-project approval exists, only a folder inside the
 * user's own home is accepted.
 *
 * The folder is stored by its real path, as the mirror's own folder is. The
 * mirror holds `<default folder>/Artifacts` to the exact path it was given, so
 * a default folder stored as typed through a link left the host's default
 * Artifacts folder refused on every write. A folder not created yet keeps its
 * nearest existing ancestor's real path and the names still to be created.
 * Resolving also normalizes `.` and `..`, so neither can name a place outside
 * home that reads as inside it.
 */
export function judgeDefaultFolder(
  candidate: DefaultFolder,
  home: string = homedir(),
): DefaultFolderVerdict {
  if (!isAbsolute(candidate)) {
    return { status: "refused", message: "The default folder must be an absolute path." };
  }
  const real = realPathThroughExistingAncestors(candidate);
  if (!isInsideHomeDirectory(real, home)) {
    return {
      status: "refused",
      message: "The default folder must be inside your home folder.",
    };
  }
  return { status: "accepted", folder: decodeDefaultFolder(real) };
}
