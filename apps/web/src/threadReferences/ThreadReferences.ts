import { createContext, useContext, useMemo, useRef } from "react";
import type { OctantMode } from "@octant/contracts/modes";
import type { CommandThread } from "../palette/buildOctantCommands";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

/** A thread this window lists, as any surface that names it can show it. */
export interface ThreadReference {
  readonly mode: OctantMode;
  readonly thread: ChatThreadNavigationItem;
  readonly projectName?: string;
  /** The listed thread this one was forked from. */
  readonly lineageParentTitle?: string;
}

/**
 * The threads this window already lists, by id. A name in a prompt, a message
 * or a receipt reads its facts here, so showing a thread's card asks the host
 * for nothing and says nothing the sidebar could not.
 */
export interface ThreadReferences {
  readonly find: (threadId: string) => ThreadReference | undefined;
  readonly open?: (reference: ThreadReference) => void;
}

const NONE: ThreadReferences = { find: () => undefined };

export const ThreadReferencesContext = createContext<ThreadReferences>(NONE);

export function useThreadReferences(): ThreadReferences {
  return useContext(ThreadReferencesContext);
}

/** Builds the window's directory from the rows its sidebar draws. */
export function useThreadReferenceDirectory(input: {
  readonly chat: ReadonlyArray<ChatThreadNavigationItem>;
  readonly work: ReadonlyArray<ChatThreadNavigationItem>;
  readonly code: ReadonlyArray<ChatThreadNavigationItem>;
  readonly withProviderMark: (thread: ChatThreadNavigationItem) => ChatThreadNavigationItem;
  readonly projects: ReadonlyArray<{ readonly id: unknown; readonly name: string }>;
  readonly onOpen: (thread: CommandThread) => void;
}): ThreadReferences {
  const { chat, work, code, withProviderMark, projects } = input;
  // The shell makes a new open handler on every render; the directory changes
  // only with the rows it lists.
  const openRef = useRef(input.onOpen);
  openRef.current = input.onOpen;
  return useMemo(() => {
    const projectNames = new Map(projects.map((project) => [String(project.id), project.name]));
    const rows = new Map<
      string,
      { readonly mode: OctantMode; readonly thread: ChatThreadNavigationItem }
    >();
    for (const [mode, threads] of [
      ["chat", chat],
      ["work", work],
      ["code", code],
    ] as const) {
      for (const thread of threads) rows.set(thread.threadId, { mode, thread });
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
          thread: withProviderMark(row.thread),
          ...(projectName === undefined ? {} : { projectName }),
          ...(parentTitle === undefined ? {} : { lineageParentTitle: parentTitle }),
        };
      },
      open: (reference) =>
        openRef.current({
          threadId: reference.thread.threadId,
          title: reference.thread.title,
          mode: reference.mode,
          ...(reference.thread.projectId === undefined
            ? {}
            : { projectId: reference.thread.projectId }),
        }),
    };
  }, [chat, code, projects, withProviderMark, work]);
}
