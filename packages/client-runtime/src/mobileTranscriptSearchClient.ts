import {
  ChatTranscriptSearch,
  CodeTranscriptSearch,
  MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH,
  ThreadSearch,
  type ThreadSearchField,
  WorkTranscriptSearch,
  decodeHostAnswer,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

export type MobileTranscriptMode = "chat" | "work" | "code";

/**
 * One match, enough to open its thread at the turn that holds it. `turnId` is
 * the id the mode's transcript keys a turn by: the Chat or Work turn id, or
 * the operation of a Code provider turn. A title match names no turn.
 */
export interface MobileTranscriptHit {
  readonly hostId: string;
  readonly mode: MobileTranscriptMode;
  readonly threadId: string;
  readonly title: string;
  readonly turnId?: string;
  /** Where the host found the text; absent from a host that predates search across modes. */
  readonly field?: ThreadSearchField;
  /** The Canvas whose words matched, on a `canvas` hit. */
  readonly canvasId?: string;
  readonly snippet: string;
}

export type MobileTranscriptSearch =
  | {
      readonly status: "ready";
      readonly hits: ReadonlyArray<MobileTranscriptHit>;
      readonly truncated: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

type ModeSearch =
  | {
      readonly status: "ready";
      readonly hits: ReadonlyArray<MobileTranscriptHit>;
      readonly truncated: boolean;
    }
  | { readonly status: "refused" | "unavailable" };

const MODES: ReadonlyArray<MobileTranscriptMode> = ["chat", "work", "code"];

/**
 * Searches one host's Chat, Work, and Code threads at once: titles, messages,
 * and tool output, through the host's search across modes, the read the
 * desktop's thread search uses. A host that predates it answers through each
 * mode's message search instead, and each mode answers on its own there: the
 * search is unavailable only when no mode answered.
 */
export async function searchMobileTranscripts(
  transport: MobileRemoteTransport,
  query: string,
  signal?: AbortSignal,
): Promise<MobileTranscriptSearch> {
  const trimmed = query.trim().slice(0, MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH);
  if (trimmed.length === 0) return { status: "ready", hits: [], truncated: false };
  const across = await searchAcrossModes(transport, trimmed, signal);
  if (across.status === "ready") {
    return { status: "ready", hits: across.hits, truncated: across.truncated };
  }
  if (across.status === "refused") {
    return {
      status: "unavailable",
      message: "This host does not share message search with paired devices.",
    };
  }
  const results = await Promise.all(
    MODES.map((mode) => searchMode(transport, mode, trimmed, signal)),
  );
  const answered = results.flatMap((result) => (result.status === "ready" ? [result] : []));
  if (answered.length === 0) {
    return {
      status: "unavailable",
      message: results.every((result) => result.status === "refused")
        ? "This host does not share message search with paired devices."
        : "Message search is not available on this host.",
    };
  }
  return {
    status: "ready",
    truncated: answered.some((result) => result.truncated),
    hits: answered.flatMap((result) => result.hits),
  };
}

/**
 * The host's search across modes. A host that predates it answers
 * `unavailable` (no such route), and so does any other failure, so the caller
 * asks each mode's older read, which may still answer. A refusal is final: the
 * older reads sit under the same grant.
 */
async function searchAcrossModes(
  transport: MobileRemoteTransport,
  query: string,
  signal: AbortSignal | undefined,
): Promise<ModeSearch> {
  try {
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: "/api/search",
      query: `?q=${encodeURIComponent(query)}&scope=all`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return { status: response.status === 403 ? "refused" : "unavailable" };
    const result = decodeHostAnswer(ThreadSearch)(await response.json());
    return {
      status: "ready",
      truncated: result.truncated,
      // A phone list shows live threads only; an archived match stays on the
      // desktop's Archived group.
      hits: result.hits
        .filter((entry) => entry.lifecycle === "active")
        .map((entry): MobileTranscriptHit => {
          const turnId = entry.mode === "code" ? entry.operationId : entry.turnId;
          return {
            hostId: transport.hostId,
            mode: entry.mode,
            threadId: String(entry.threadId),
            title: entry.title,
            ...(turnId === undefined ? {} : { turnId: String(turnId) }),
            field: entry.field,
            ...(entry.canvasId === undefined ? {} : { canvasId: String(entry.canvasId) }),
            snippet: entry.snippet,
          };
        }),
    };
  } catch {
    return { status: "unavailable" };
  }
}

async function searchMode(
  transport: MobileRemoteTransport,
  mode: MobileTranscriptMode,
  query: string,
  signal: AbortSignal | undefined,
): Promise<ModeSearch> {
  try {
    const response = await transport.authenticatedFetch({
      method: "GET",
      path: `/api/${mode}/transcript-search`,
      query: `?q=${encodeURIComponent(query)}`,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return { status: response.status === 403 ? "refused" : "unavailable" };
    const body: unknown = await response.json();
    const hit = (threadId: unknown, title: string, turnId: unknown, snippet: string) => ({
      hostId: transport.hostId,
      mode,
      threadId: String(threadId),
      title,
      turnId: String(turnId),
      snippet,
    });
    // A phone list shows live threads only; an archived match stays on the
    // desktop's Archived group.
    if (mode === "code") {
      const result = decodeHostAnswer(CodeTranscriptSearch)(body);
      return {
        status: "ready",
        truncated: result.truncated,
        hits: result.hits
          .filter((entry) => entry.lifecycle === "active")
          .map((entry) => hit(entry.threadId, entry.title, entry.operationId, entry.snippet)),
      };
    }
    const result =
      mode === "work"
        ? decodeHostAnswer(WorkTranscriptSearch)(body)
        : decodeHostAnswer(ChatTranscriptSearch)(body);
    return {
      status: "ready",
      truncated: result.truncated,
      hits: result.hits
        .filter((entry) => entry.lifecycle === "active")
        .map((entry) => hit(entry.threadId, entry.title, entry.turnId, entry.snippet)),
    };
  } catch {
    return { status: "unavailable" };
  }
}
