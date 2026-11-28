import { offerFilesToThread, threadImageOfferKey, threadImageOffers } from "./threadImageOffers";

/**
 * The file offers a sidebar row drop and the Chat composer use, loaded on
 * their own (a dynamic import of `threadImageOffers` itself would make the
 * first load carry a module-namespace helper for it).
 */
export function offerRowFiles(
  mode: "chat" | "work" | "code",
  threadId: string,
  files: ReadonlyArray<File>,
  say: (sentence: string) => void,
): Promise<void> {
  return offerFilesToThread(mode, threadId, files, say);
}

/**
 * Hands this Chat thread's offered files to its composer while it is open.
 * `take` resolves with whether Chat accepted the file or refused it with a
 * reason, so a drop of several files can name every refusal.
 */
export function takeChatFiles(
  threadId: string,
  take: (
    file: File,
  ) => Promise<
    { readonly status: "accepted" } | { readonly status: "refused"; readonly reason: string }
  >,
): () => void {
  return threadImageOffers.subscribe(threadImageOfferKey("chat", threadId), (file) => take(file));
}
