import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeThread,
  type Project,
  type ProjectId,
  type ProviderInstance,
  type ProviderInstanceId,
  type ThreadProjectCode,
  type WorkThread,
} from "@octant/contracts";
import { projectCodeEntries, projectCodeTrust } from "@octant/domain";

export interface ThreadProjectCodeSources {
  readonly readWorkThread: (threadId: WorkThread["id"]) => WorkThread | undefined;
  readonly readCodeThread: (threadId: CodeThread["id"]) => CodeThread | undefined;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly readProviderInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  /** Whether an entry exists at this path; a symbolic link counts without being followed. */
  readonly exists?: (path: string) => Promise<boolean>;
}

/**
 * Whether a Work or Code thread's Project holds its key provider's own
 * Project code, and whether the Project trusts that provider for it. Reads
 * only whether each entry the provider's driver treats as Project code exists
 * at the Project root: nothing is opened, parsed, or run, and the answer
 * changes no trust.
 */
export async function readThreadProjectCode(
  sources: ThreadProjectCodeSources,
  input: { readonly threadId: string; readonly mode: "work" | "code" },
): Promise<ThreadProjectCode> {
  const thread =
    input.mode === "work"
      ? sources.readWorkThread(decodeWorkThreadId(input.threadId))
      : sources.readCodeThread(decodeCodeThreadId(input.threadId));
  if (thread === undefined) return { status: "none" };
  const project = sources.readProject(thread.projectId);
  if (project === undefined || project.type === "chat") return { status: "none" };
  const instance = sources.readProviderInstance(thread.providerInstanceId);
  if (instance === undefined) return { status: "none" };
  const entries = projectCodeEntries(instance.driverKind);
  if (entries.length === 0) return { status: "none" };
  const exists = sources.exists ?? entryExists;
  const root = project.binding.canonicalRoot;
  const present = await Promise.all(
    entries.map(async (entry) =>
      (await exists(join(root, ...entry.path.split("/")))) ? entry.path : undefined,
    ),
  );
  return projectCodeTrust({
    driverKind: instance.driverKind,
    projectType: project.type,
    trusted: (project.nativeProviders ?? []).some((kind) => kind === instance.driverKind),
    present: present.filter((path): path is string => path !== undefined),
  });
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
