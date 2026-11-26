import {
  offerFilesToThread,
  THREAD_FILE_OFFERS_FULL,
  threadImageOfferKey,
  threadImageOffers,
} from "./threadImageOffers";

/**
 * The file offers a sidebar row drop and the Chat composer use, loaded on
 * their own (a dynamic import of `threadImageOffers` itself would make the
 * first load carry a module-namespace helper for it).
 */
export async function offerRowFiles(
  mode: "chat" | "work" | "code",
  threadId: string,
  files: ReadonlyArray<File>,
  sayFull: (sentence: string) => void,
): Promise<void> {
  if (await offerFilesToThread(mode, threadId, files)) sayFull(THREAD_FILE_OFFERS_FULL);
}

/** Hands this Chat thread's offered files to its composer while it is open. */
export function takeChatFiles(threadId: string, take: (file: File) => void): () => void {
  return threadImageOffers.subscribe(threadImageOfferKey("chat", threadId), (file) => {
    take(file);
    return { status: "accepted" };
  });
}
