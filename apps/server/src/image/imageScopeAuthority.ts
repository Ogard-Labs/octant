/**
 * Chat image jobs are scoped to a thread. Window capability only proves the
 * caller is a registered window of this host; the Projects its Chat layout
 * shows decide which Project's threads that window may open.
 */
export function chatImageScopeAllowedForWindow(input: {
  /** Whether the window's Chat layout reaches a Project (`null`: no Project); absent for no window. */
  readonly chatAdmits: ((projectId: string | null) => boolean) | undefined;
  readonly thread:
    | { readonly projectId?: string | undefined; readonly lifecycle: string }
    | undefined;
}): boolean {
  if (input.chatAdmits === undefined || input.thread === undefined) return false;
  if (input.thread.lifecycle === "deleted") return false;
  return input.chatAdmits(input.thread.projectId ?? null);
}
