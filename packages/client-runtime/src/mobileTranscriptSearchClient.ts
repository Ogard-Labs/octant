import {
  ChatTranscriptSearch,
  MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH,
  decodeHostAnswer,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/** One message match, enough to open its thread at the turn that holds it. */
export interface MobileTranscriptHit {
  readonly hostId: string;
  readonly threadId: string;
  readonly title: string;
  readonly turnId: string;
  readonly snippet: string;
}

export type MobileTranscriptSearch =
  | {
      readonly status: "ready";
      readonly hits: ReadonlyArray<MobileTranscriptHit>;
      readonly truncated: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * Searches the text of Chat messages on one host, the read the desktop's
 * thread search uses. Work and Code have no message search on the host, so
 * the phone, like the desktop, searches only their titles.
 */
export async function searchMobileChatTranscripts(
  transport: MobileRemoteTransport,
  query: string,
  signal?: AbortSignal,
): Promise<MobileTranscriptSearch> {
  const trimmed = query.trim().slice(0, MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH);
  if (trimmed.length === 0) return { status: "ready", hits: [], truncated: false };
  try {
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/chat/transcript-search",
      query: `?q=${encodeURIComponent(trimmed)}`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      return {
        status: "unavailable",
        message:
          response.status === 403
            ? "This host does not share message search with paired devices."
            : "Message search is not available on this host.",
      };
    }
    const result = decodeHostAnswer(ChatTranscriptSearch)(await response.json());
    return {
      status: "ready",
      truncated: result.truncated,
      hits: result.hits
        .filter((hit) => hit.lifecycle === "active")
        .map((hit) => ({
          hostId: transport.hostId,
          threadId: String(hit.threadId),
          title: hit.title,
          turnId: String(hit.turnId),
          snippet: hit.snippet,
        })),
    };
  } catch {
    return { status: "unavailable", message: "Message search could not be read." };
  }
}
