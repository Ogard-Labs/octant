import {
  decodeHostAnswer,
  REPLY_DETAIL_PATH,
  ReplyDetailReading,
  type ReplyDetailReading as ReplyDetailReadingType,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/**
 * The host's Reply detail default and the threads that chose their own level,
 * for a client that cannot read shell settings: the phone and a paired
 * browser. Anything but the host's own answer reads as `undefined`, and the
 * caller draws the quiet Low default; a presentation preference never blocks
 * a transcript from showing.
 */
async function readReplyDetail(
  send: () => Promise<Response>,
): Promise<ReplyDetailReadingType | undefined> {
  try {
    const response = await send();
    if (!response.ok) return undefined;
    return decodeHostAnswer(ReplyDetailReading)(await response.json());
  } catch {
    return undefined;
  }
}

export function readMobileReplyDetail(input: {
  readonly transport: MobileRemoteTransport;
  readonly signal?: AbortSignal;
}): Promise<ReplyDetailReadingType | undefined> {
  return readReplyDetail(() =>
    input.transport.authenticatedFetch({
      method: "GET",
      path: REPLY_DETAIL_PATH,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
  );
}

export interface ReplyDetailClient {
  readonly read: (signal?: AbortSignal) => Promise<ReplyDetailReadingType | undefined>;
}

/** Reads over a product fetch port, as a paired browser's clients do. */
export function createReplyDetailClient(port: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}): ReplyDetailClient {
  return {
    read: (signal) =>
      readReplyDetail(() =>
        port.fetch(new URL(REPLY_DETAIL_PATH, port.baseUrl), {
          method: "GET",
          headers: { accept: "application/json" },
          ...(signal === undefined ? {} : { signal }),
        }),
      ),
  };
}
