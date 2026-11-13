import {
  decodeHostAnswer,
  REPLY_DETAIL_PATH,
  ReplyDetailReading,
  SHELL_SETTINGS_PATH,
  ShellSettingsReading,
  type ReplyDetailLevel,
  type ReplyDetailReading as ReplyDetailReadingType,
} from "@octant/contracts";
import { withThreadReplyDetail, type ReplyDetailThread } from "@octant/domain/reply-detail-policy";
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
  /**
   * Sets a thread's own level, or clears it, through the host's shell
   * settings route, which the host opens only to a device its own person
   * paired. Answers the reading after the change, or `undefined` when the
   * host refused or the settings changed underneath (the caller reads again).
   */
  readonly setThreadLevel: (
    thread: ReplyDetailThread,
    level: ReplyDetailLevel | undefined,
  ) => Promise<ReplyDetailReadingType | undefined>;
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
    setThreadLevel: async (thread, level) => {
      try {
        const url = new URL(SHELL_SETTINGS_PATH, port.baseUrl);
        const current = await port.fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (!current.ok) return undefined;
        const { settings, version } = decodeHostAnswer(ShellSettingsReading)(await current.json());
        const replaced = await port.fetch(url, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            expectedVersion: version,
            settings: {
              ...settings,
              threadReplyDetail: withThreadReplyDetail(settings.threadReplyDetail, thread, level),
            },
          }),
        });
        if (!replaced.ok) return undefined;
        const answer: unknown = await replaced.json();
        const saved = decodeHostAnswer(ShellSettingsReading)({
          settings: (answer as { readonly settings?: unknown }).settings,
          version: (answer as { readonly version?: unknown }).version,
        }).settings;
        return { defaultLevel: saved.replyDetail, threads: saved.threadReplyDetail };
      } catch {
        return undefined;
      }
    },
  };
}
