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
 * `take` resolves with the reason it refused a file, at once or while the
 * file uploaded, so a drop of several files can name every refusal.
 */
export function takeChatFiles(
  threadId: string,
  take: (file: File) => Promise<string | undefined>,
): () => void {
  return threadImageOffers.subscribe(threadImageOfferKey("chat", threadId), async (file) => {
    const reason = await take(file);
    return reason === undefined ? { status: "accepted" } : { status: "refused", reason };
  });
}
