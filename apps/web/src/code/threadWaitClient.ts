import { decodeHostAnswer, type CodeThreadId } from "@octant/contracts";
import type { CodeThreadPullRequestWait } from "@octant/contracts/code-project-pull-request-switches";

/** Reads and stops the pull requests a Code thread waits on between turns. */
export interface ThreadWaitClient {
  readonly waits: (threadId: CodeThreadId) => Promise<ReadonlyArray<CodeThreadPullRequestWait>>;
  readonly stop: (threadId: CodeThreadId, wait: CodeThreadPullRequestWait) => Promise<boolean>;
}

// Only a thread that is open reads these schemas, so a window's first load never carries them.
const loadContracts = () => import("@octant/contracts/code-project-pull-request-switches");

export function createThreadWaitClient(options: {
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
}): ThreadWaitClient {
  const request = options.fetch ?? globalThis.fetch;
  const base = options.serverUrl.replace(/\/$/, "");
  const headers = { "x-octant-window-capability": options.windowCapability };
  async function json(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(`${base}${path}`, {
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    if (!response.ok) throw new Error("What this thread waits on is unavailable.");
    return await response.json();
  }
  return {
    waits: async (threadId) => {
      const { CodeThreadPullRequestWaits } = await loadContracts();
      const query = new URLSearchParams({ threadId: String(threadId) });
      const listed = decodeHostAnswer(CodeThreadPullRequestWaits)(
        await json(`/api/code-thread-waits?${query}`, { headers, cache: "no-store" }),
      );
      if (String(listed.threadId) !== String(threadId)) {
        throw new Error("This computer returned what another thread waits on.");
      }
      return listed.waits;
    },
    stop: async (threadId, wait) => {
      const { StopCodeThreadPullRequestWaitResult } = await loadContracts();
      const answer = decodeHostAnswer(StopCodeThreadPullRequestWaitResult)(
        await json("/api/code-thread-waits/stop", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            kind: "stop-code-thread-pull-request-wait",
            threadId,
            wait: wait.kind === "watch" ? "watch" : "auto-fix",
            target: wait.target,
            since: wait.since,
          }),
        }),
      );
      return answer.stopped;
    },
  };
}
