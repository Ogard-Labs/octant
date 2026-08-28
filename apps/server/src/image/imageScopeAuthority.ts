/**
 * Chat image jobs are scoped to a thread. Window capability only proves the
 * caller is a registered window of this host; the Chat workspace context is
 * what decides which Project's threads that window may open.
 */
export function chatImageScopeAllowedForWindow(input: {
  readonly chatContext: { readonly mode: string; readonly projectId: string | null } | undefined;
  readonly thread:
    | { readonly projectId?: string | undefined; readonly lifecycle: string }
    | undefined;
}): boolean {
  if (input.chatContext === undefined || input.thread === undefined) return false;
  if (input.chatContext.mode !== "chat") return false;
  if (input.thread.lifecycle === "deleted") return false;
  return String(input.chatContext.projectId) === String(input.thread.projectId ?? null);
}
