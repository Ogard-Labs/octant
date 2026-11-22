import {
  ACCESS_ACTIVITY_PATH,
  AccessActivityList,
  CHANGE_NOTICE_ACTION_PATHS,
  CHANGE_NOTICES_PATH,
  ChangeNoticeList,
  type AccessActivityList as AccessActivityListType,
  type ChangeNoticeList as ChangeNoticeListType,
} from "@octant/contracts/access-activity";
import { decodeHostAnswer } from "@octant/contracts";

/** What a notice action came back with: done, or the host's reason it refused. */
export type ChangeNoticeActionResult =
  | { readonly status: "done" }
  | { readonly status: "refused"; readonly message: string };

/**
 * Access activity and change notices (maintainer decision, 2026-11-22), for a
 * window on the host or a device paired at Full. A refusal or an answer off
 * the contract reads as `undefined`, so a client keeps what it last showed.
 */
export interface AccessActivityClient {
  readonly readActivity: (signal?: AbortSignal) => Promise<AccessActivityListType | undefined>;
  readonly readNotices: (signal?: AbortSignal) => Promise<ChangeNoticeListType | undefined>;
  readonly act: (
    action: keyof typeof CHANGE_NOTICE_ACTION_PATHS,
    noticeId: string,
  ) => Promise<ChangeNoticeActionResult>;
}

export function createAccessActivityClient(port: {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** A window's capability; a paired device sends none and its session carries it. */
  readonly windowCapability?: string;
}): AccessActivityClient {
  const capability =
    port.windowCapability === undefined || port.windowCapability === ""
      ? {}
      : { "x-octant-window-capability": port.windowCapability };
  const read = async <T>(
    path: string,
    decode: (value: unknown) => T,
    signal: AbortSignal | undefined,
  ): Promise<T | undefined> => {
    try {
      const response = await port.fetch(new URL(path, port.baseUrl), {
        method: "GET",
        headers: { accept: "application/json", ...capability },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) return undefined;
      return decode(await response.json());
    } catch {
      return undefined;
    }
  };
  return {
    readActivity: (signal) =>
      read(ACCESS_ACTIVITY_PATH, decodeHostAnswer(AccessActivityList), signal),
    readNotices: (signal) => read(CHANGE_NOTICES_PATH, decodeHostAnswer(ChangeNoticeList), signal),
    act: async (action, noticeId) => {
      try {
        const response = await port.fetch(
          new URL(CHANGE_NOTICE_ACTION_PATHS[action], port.baseUrl),
          {
            method: "POST",
            headers: { "content-type": "application/json", ...capability },
            body: JSON.stringify({ noticeId }),
          },
        );
        if (response.ok) return { status: "done" };
        const body: unknown = await response.json().catch(() => undefined);
        return {
          status: "refused",
          message:
            typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof body.message === "string"
              ? body.message
              : "The host did not take that.",
        };
      } catch {
        return { status: "refused", message: "The host could not be reached." };
      }
    },
  };
}
