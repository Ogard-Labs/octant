import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DefaultFolder, type ShellSettings } from "@octant/contracts";
import { Schema } from "effect";

const decodeDefaultFolder = Schema.decodeUnknownSync(DefaultFolder);

/**
 * The folder Octant uses for anything nobody gave a home. Work and Code
 * threads started without a Project bind a subfolder of it, and artifact
 * files mirror under it unless the mirror names another place.
 */
export const DEFAULT_FOLDER_WORK_SUBFOLDER = "Work";
export const DEFAULT_FOLDER_CODE_SUBFOLDER = "Code";
export const DEFAULT_FOLDER_ARTIFACTS_SUBFOLDER = "Artifacts";

export function hostDefaultFolder(home: string = homedir()): DefaultFolder {
  return decodeDefaultFolder(join(home, "Documents", "Octant"));
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
 * user's own home is accepted. The path is normalized before the check so a
 * `..` segment cannot name a place outside home that reads as inside it.
 */
export function judgeDefaultFolder(
  candidate: DefaultFolder,
  home: string = homedir(),
): DefaultFolderVerdict {
  if (!isAbsolute(candidate)) {
    return { status: "refused", message: "The default folder must be an absolute path." };
  }
  const normalized = resolve(candidate);
  const inside = relative(resolve(home), normalized);
  if (
    inside === "" ||
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    inside.includes(`..${sep}`)
  ) {
    return {
      status: "refused",
      message: "The default folder must be inside your home folder.",
    };
  }
  return { status: "accepted", folder: decodeDefaultFolder(normalized) };
}
