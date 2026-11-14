import {
  AdoptCodeNativeSessionResult,
  CodeLiveTasks,
  CodeNativeSessions,
  decodeHostAnswer,
  StopCodeLiveTasksResult,
  type CodeNativeSessionId,
  type CodeThreadId,
} from "@octant/contracts";

/**
 * Reads and stops the background work a Code thread's provider session keeps
 * running, and starts an empty thread from a session begun outside Octant.
 */
export interface CodeSessionClient {
  readonly liveTasks: (threadId: CodeThreadId) => Promise<CodeLiveTasks>;
  readonly stopLiveTasks: (threadId: CodeThreadId) => Promise<StopCodeLiveTasksResult>;
  readonly nativeSessions?: (threadId: CodeThreadId) => Promise<CodeNativeSessions>;
  readonly adoptNativeSession?: (
    threadId: CodeThreadId,
    nativeSessionId: CodeNativeSessionId,
  ) => Promise<AdoptCodeNativeSessionResult>;
}

export function createCodeSessionClient(options: {
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
}): CodeSessionClient {
  const request = options.fetch ?? globalThis.fetch;
  const base = options.serverUrl.replace(/\/$/, "");
  const headers = { "x-octant-window-capability": options.windowCapability };
  async function json(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(`${base}${path}`, {
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    if (!response.ok) throw new Error("The host's live tasks are unavailable.");
    return await response.json();
  }
  return {
    liveTasks: async (threadId) => {
      const query = new URLSearchParams({ threadId: String(threadId) });
      const live = decodeHostAnswer(CodeLiveTasks)(
        await json(`/api/code-live-tasks?${query}`, { headers, cache: "no-store" }),
      );
      if (String(live.threadId) !== String(threadId)) {
        throw new Error("The host returned another thread's live tasks.");
      }
      return live;
    },
    nativeSessions: async (threadId) => {
      const query = new URLSearchParams({ threadId: String(threadId) });
      const listed = decodeHostAnswer(CodeNativeSessions)(
        await json(`/api/code-native-sessions?${query}`, { headers, cache: "no-store" }),
      );
      if (String(listed.threadId) !== String(threadId)) {
        throw new Error("The host returned another thread's sessions.");
      }
      return listed;
    },
    adoptNativeSession: async (threadId, nativeSessionId) =>
      decodeHostAnswer(AdoptCodeNativeSessionResult)(
        await json("/api/code-native-sessions/adopt", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "adopt-code-native-session", threadId, nativeSessionId }),
        }),
      ),
    stopLiveTasks: async (threadId) =>
      decodeHostAnswer(StopCodeLiveTasksResult)(
        await json("/api/code-live-tasks/stop", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "stop-code-live-tasks", threadId }),
        }),
      ),
  };
}
