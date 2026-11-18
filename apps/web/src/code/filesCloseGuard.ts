/**
 * Lets the dock ask the Files tool whether it may close. A mounted Files viewer
 * registers a guard that walks its files with unsaved edits and asks the person
 * about each; the dock closes the tool only when every guard agrees.
 */
type FilesCloseGuard = () => Promise<boolean>;

const guards = new Set<FilesCloseGuard>();

export function registerFilesCloseGuard(guard: FilesCloseGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export async function confirmFilesClose(): Promise<boolean> {
  for (const guard of [...guards]) {
    if (!(await guard())) return false;
  }
  return true;
}
