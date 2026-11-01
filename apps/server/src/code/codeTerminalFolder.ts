import { statSync } from "node:fs";

/**
 * Where a thread's terminal starts and which other folders of the Project it
 * binds. The terminal starts in the thread's working directory unless the
 * person picks one of the Project's extra folders, compared as the exact path
 * the Project lists; any other path is refused, so a caller cannot reach a
 * folder by describing it another way. Every extra folder that exists is bound
 * like the working directory, so the shell can move between them.
 */
export function chooseThreadTerminalFolder(input: {
  readonly workingDirectory: string;
  readonly extraFolders: ReadonlyArray<string>;
  readonly picked: string | undefined;
  readonly isDirectory?: (path: string) => boolean;
}):
  | { readonly kind: "chosen"; readonly cwd: string; readonly extraFolders: ReadonlyArray<string> }
  | { readonly kind: "refused" } {
  const isDirectory = input.isDirectory ?? directoryExists;
  const cwd = input.picked ?? input.workingDirectory;
  if (cwd !== input.workingDirectory && (!input.extraFolders.includes(cwd) || !isDirectory(cwd))) {
    return { kind: "refused" };
  }
  return {
    kind: "chosen",
    cwd,
    extraFolders: [input.workingDirectory, ...input.extraFolders.filter(isDirectory)].filter(
      (folder) => folder !== cwd,
    ),
  };
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
