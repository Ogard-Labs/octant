import type { GitHistoryQuery, GitHistoryResult } from "@octant/contracts/git-history";

/** Authorized, read-only Git access. Modules receive no path or process handle. */
export interface GitHistoryReader {
  read(query: GitHistoryQuery, signal?: AbortSignal): Promise<GitHistoryResult>;
}
