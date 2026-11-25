import { useContext } from "react";
import type { OctantMode } from "@octant/contracts/modes";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { ThreadReferencesContext, type ThreadReferenceLists } from "./ThreadReferences";

/** A thread this window lists, as any surface that names it can show it. */
export interface ThreadReference {
  readonly mode: OctantMode;
  readonly thread: ChatThreadNavigationItem;
  readonly projectName?: string;
  /** The listed thread this one was forked from. */
  readonly lineageParentTitle?: string;
}

/**
 * The threads the host already lists to this window, by id, a worker the
 * sidebar leaves out included, as Needs you and search include it. A name in a
 * prompt, a message or a receipt reads its facts here, so showing a thread's
 * card asks the host for nothing.
 */
export interface ThreadReferences {
  readonly find: (threadId: string) => ThreadReference | undefined;
  readonly open?: (reference: ThreadReference) => void;
}

const NONE: ThreadReferences = { find: () => undefined };

// Every chip on screen reads the same lists, so they are indexed once for all.
const directories = new WeakMap<ThreadReferenceLists, ThreadReferences>();

export function useThreadReferences(): ThreadReferences {
  const lists = useContext(ThreadReferencesContext);
  if (lists === undefined) return NONE;
  let directory = directories.get(lists);
  if (directory === undefined) {
    directory = threadReferenceDirectory(lists);
    directories.set(lists, directory);
  }
  return directory;
}

function threadReferenceDirectory(lists: ThreadReferenceLists): ThreadReferences {
  const projectNames = new Map(lists.projects.map((project) => [String(project.id), project.name]));
  const rows = new Map<
    string,
    { readonly mode: OctantMode; readonly thread: ChatThreadNavigationItem }
  >();
  for (const mode of ["chat", "work", "code"] as const) {
    for (const thread of lists[mode]) rows.set(thread.threadId, { mode, thread });
  }
  return {
    find: (threadId) => {
      const row = rows.get(threadId);
      if (row === undefined) return undefined;
      const { projectId, lineageParentThreadId } = row.thread;
      const projectName = projectId === undefined ? undefined : projectNames.get(projectId);
      const parentTitle =
        lineageParentThreadId === undefined
          ? undefined
          : rows.get(lineageParentThreadId)?.thread.title;
      return {
        mode: row.mode,
        thread: lists.withProviderMark(row.thread),
        ...(projectName === undefined ? {} : { projectName }),
        ...(parentTitle === undefined ? {} : { lineageParentTitle: parentTitle }),
      };
    },
    open: (reference) =>
      lists.onOpen({
        threadId: reference.thread.threadId,
        title: reference.thread.title,
        mode: reference.mode,
        ...(reference.thread.projectId === undefined
          ? {}
          : { projectId: reference.thread.projectId }),
      }),
  };
}
