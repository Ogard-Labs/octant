import { decodeChatThreadId } from "@octant/contracts/chat";
import type { OctantMode } from "@octant/contracts/modes";

export function readContinuationLink(
  value: string,
): { readonly mode: OctantMode; readonly threadId: string } | undefined {
  try {
    const url = new URL(value);
    const mode = url.searchParams.get("continueMode");
    const threadId = decodeChatThreadId(url.searchParams.get("continueThread"));
    return mode === "chat" || mode === "work" || mode === "code"
      ? { mode, threadId: String(threadId) }
      : undefined;
  } catch {
    return undefined;
  }
}
export function continuationLink(
  origin: string,
  mode: OctantMode,
  threadId: string,
): string | undefined {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.origin !== origin
    )
      return undefined;
    url.searchParams.set("continueMode", mode);
    url.searchParams.set("continueThread", String(decodeChatThreadId(threadId)));
    return url.toString();
  } catch {
    return undefined;
  }
}
