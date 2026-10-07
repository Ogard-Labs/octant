import type { ThreadRowActions } from "./ThreadRowMenu";

/**
 * One row menu over two kinds of thread. Work lists Chat and Work threads
 * together, but each kind keeps its own host commands, so every action
 * dispatches by the row's thread: a Chat row never reaches a Work command or
 * the reverse. An action only one kind supports is offered on every row and
 * does nothing on the other kind's.
 */
export function mergeThreadRowActions(
  isFirstKind: (threadId: string) => boolean,
  first: ThreadRowActions,
  second: ThreadRowActions,
): ThreadRowActions {
  const pick = (threadId: string) => (isFirstKind(threadId) ? first : second);
  const openPullRequest = first.onOpenPullRequest ?? second.onOpenPullRequest;
  const openPullRequestOnGithub =
    first.onOpenPullRequestOnGithub ?? second.onOpenPullRequestOnGithub;
  const either = <K extends keyof ThreadRowActions>(key: K): boolean =>
    first[key] !== undefined || second[key] !== undefined;
  return {
    ...(either("onArchiveThread")
      ? { onArchiveThread: (id: string) => pick(id).onArchiveThread?.(id) }
      : {}),
    ...(either("onCompleteThread")
      ? { onCompleteThread: (id: string) => pick(id).onCompleteThread?.(id) }
      : {}),
    ...(either("onReopenThread")
      ? { onReopenThread: (id: string) => pick(id).onReopenThread?.(id) }
      : {}),
    ...(either("onSnoozeThread")
      ? {
          onSnoozeThread: (id: string, until: string) => pick(id).onSnoozeThread?.(id, until),
        }
      : {}),
    ...(either("onWakeThread")
      ? { onWakeThread: (id: string) => pick(id).onWakeThread?.(id) }
      : {}),
    ...(either("onCompleteFollowUp")
      ? { onCompleteFollowUp: (id: string) => pick(id).onCompleteFollowUp?.(id) }
      : {}),
    ...(either("onMarkFollowUp")
      ? { onMarkFollowUp: (id: string) => pick(id).onMarkFollowUp?.(id) }
      : {}),
    ...(either("onExportThread")
      ? {
          onExportThread: (id: string, title: string) => pick(id).onExportThread?.(id, title),
        }
      : {}),
    ...(either("onHandOffThread")
      ? {
          onHandOffThread: (id: string, title: string) => pick(id).onHandOffThread?.(id, title),
        }
      : {}),
    ...(either("onMarkThreadRead")
      ? { onMarkThreadRead: (id: string) => pick(id).onMarkThreadRead?.(id) }
      : {}),
    ...(either("onMarkThreadUnread")
      ? { onMarkThreadUnread: (id: string) => pick(id).onMarkThreadUnread?.(id) }
      : {}),
    ...(either("onPinInPane") ? { onPinInPane: (id: string) => pick(id).onPinInPane?.(id) } : {}),
    ...(either("onAttachAsContext")
      ? {
          onAttachAsContext: (id: string, title: string) => pick(id).onAttachAsContext?.(id, title),
        }
      : {}),
    ...(either("onPinThread")
      ? {
          onPinThread: (id: string, pinned: boolean) => pick(id).onPinThread?.(id, pinned),
        }
      : {}),
    // Pull request links carry no thread id; each kind's opener reaches the
    // same Review dock or browser, so the first one present serves both.
    ...(openPullRequest === undefined ? {} : { onOpenPullRequest: openPullRequest }),
    ...(openPullRequestOnGithub === undefined
      ? {}
      : { onOpenPullRequestOnGithub: openPullRequestOnGithub }),
    ...(either("onStartRenameThread")
      ? { onStartRenameThread: (id: string) => pick(id).onStartRenameThread?.(id) }
      : {}),
  };
}
