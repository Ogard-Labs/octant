import type { ChatThreadNavigationItem, ThreadProviderIdentity } from "../shell/navigationModel";
import type { sidebarThreadGroupsForMode } from "../shell/shellModeRouting";

/**
 * The thread rows the shell derives once per navigation change for every
 * surface that lists, titles or marks threads: the sidebar, the dock's thread
 * overview and the pane headers. One model, so a row cannot say one thing in
 * the sidebar and another in the pane.
 */
export interface ShellNavigationModel {
  readonly codeProjectThreads: ReadonlyArray<ChatThreadNavigationItem>;
  readonly liveThreadTitles: ReadonlyMap<string, string>;
  readonly markedChatNavigation: ReadonlyArray<ChatThreadNavigationItem>;
  readonly markedThreadGroups: ReturnType<typeof sidebarThreadGroupsForMode>;
  readonly providerByThreadId: ReadonlyMap<string, ThreadProviderIdentity>;
  readonly runningThreadIds: ReadonlySet<string>;
  readonly withProviderMark: (thread: ChatThreadNavigationItem) => ChatThreadNavigationItem;
  readonly workProjectThreads: ReadonlyArray<ChatThreadNavigationItem>;
}
