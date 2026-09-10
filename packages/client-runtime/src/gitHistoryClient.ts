import {
  decodeGitHistoryQuery,
  decodeGitHistoryResult,
  type GitHistoryQuery,
  type GitHistoryResult,
} from "@octant/contracts/git-history";
import { bindFetchPort } from "./bindFetchPort";

export interface GitHistoryClient {
  read(query: GitHistoryQuery, signal?: AbortSignal): Promise<GitHistoryResult>;
}

export function createGitHistoryClient(options: {
  readonly baseUrl: string;
  readonly windowCapability: string;
  readonly fetch: typeof globalThis.fetch;
}): GitHistoryClient {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username !== "" ||
    base.password !== ""
  )
    throw new Error("Git history requires an authorized loopback transport.");
  const fetch = bindFetchPort(options.fetch);
  return {
    async read(input, signal) {
      const query = decodeGitHistoryQuery(input);
      const url = new URL("/api/code/git/history", base);
      url.searchParams.set("query", JSON.stringify(query));
      const response = await fetch(url.toString(), {
        method: "GET",
        redirect: "error",
        headers: { "x-octant-window-capability": options.windowCapability },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok)
        return {
          status: "unavailable",
          message:
            response.status === 401 || response.status === 403
              ? "Git history access is unavailable. Reconnect and retry."
              : "Git history could not be loaded. Retry the request.",
        };
      const result = decodeGitHistoryResult(await response.json());
      if (
        result.status !== "unavailable" &&
        (String(result.threadId) !== String(query.threadId) ||
          String(result.checkoutId) !== String(query.checkoutId) ||
          result.status !== query.kind ||
          (result.status === "commit" &&
            query.kind === "commit" &&
            result.commit.oid !== query.oid))
      )
        return {
          status: "unavailable",
          message: "Git history returned a different checkout or commit. Refresh and retry.",
        };
      return result;
    },
  };
}
