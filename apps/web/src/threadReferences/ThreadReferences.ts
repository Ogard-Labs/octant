import type { ConnectedGitHubRepository, ThreadBoardPullRequestIdentity } from "@octant/contracts";
import { createContext, useMemo, useRef } from "react";
import type { CommandThread } from "../palette/buildOctantCommands";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { ExternalUrlHost } from "../shell/openExternalUrl";

type Rows = ReadonlyArray<ChatThreadNavigationItem>;

/**
 * The window's full thread lists, and how it opens one. Only the context and
 * this hook load with the window; looking a thread up in the lists is
 * `useThreadReferences`, which loads with the first surface that names one.
 */
export interface ThreadReferenceLists {
  readonly chat: Rows;
  readonly work: Rows;
  readonly code: Rows;
  readonly withProviderMark: (thread: ChatThreadNavigationItem) => ChatThreadNavigationItem;
  /** Every Project the window lists; a Code one carries the repository the host observed. */
  readonly projects: ReadonlyArray<{
    readonly id: unknown;
    readonly name: string;
    readonly type?: string;
    readonly lifecycle?: string;
    readonly connectedRepository?: ConnectedGitHubRepository | undefined;
  }>;
  readonly onOpen: (thread: CommandThread) => void;
  /** Opens Octant's pane on a pull request a text names, in a Project this window holds. */
  readonly onOpenPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  /** Where any other link named in text opens: the desktop's browser, else the window's. */
  readonly externalHost?: ExternalUrlHost | undefined;
}

export const ThreadReferencesContext = createContext<ThreadReferenceLists | undefined>(undefined);

/** Holds the lists steady between changes: the shell makes a new open handler on every render. */
export function useThreadReferenceLists(input: ThreadReferenceLists): ThreadReferenceLists {
  const open = useRef(input.onOpen);
  open.current = input.onOpen;
  const openPullRequest = useRef(input.onOpenPullRequest);
  openPullRequest.current = input.onOpenPullRequest;
  return useMemo(
    () => ({
      ...input,
      onOpen: (thread) => open.current(thread),
      onOpenPullRequest: (identity) => openPullRequest.current?.(identity),
    }),
    [input.chat, input.work, input.code, input.withProviderMark, input.projects],
  );
}
