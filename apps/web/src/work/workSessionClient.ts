import {
  AdoptWorkNativeSessionResult,
  decodeHostAnswer,
  StopWorkLiveTasksResult,
  WorkLiveTasks,
  WorkNativeSessions,
  type WorkThreadId,
} from "@octant/contracts";
import type { ThreadSessionClient } from "../code/codeSessionClient";

/**
 * Reads and stops the background work a Work thread's provider session keeps
 * running, and starts an empty Work thread from a session begun outside
 * Octant, through the host's Work session routes.
 */
export function createWorkSessionClient(options: {
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
}): ThreadSessionClient<WorkThreadId> {
  const request = options.fetch ?? globalThis.fetch;
  const base = options.serverUrl.replace(/\/$/, "");
  const headers = { "x-octant-window-capability": options.windowCapability };
  async function json(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(`${base}${path}`, {
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    if (!response.ok) throw new Error("The host's session details are unavailable.");
    return await response.json();
  }
  return {
    liveTasks: async (threadId) => {
      const query = new URLSearchParams({ threadId: String(threadId) });
      const live = decodeHostAnswer(WorkLiveTasks)(
        await json(`/api/work-live-tasks?${query}`, { headers, cache: "no-store" }),
      );
      if (String(live.threadId) !== String(threadId))
        throw new Error("The host returned another thread's live tasks.");
      return live;
    },
    stopLiveTasks: async (threadId) =>
      decodeHostAnswer(StopWorkLiveTasksResult)(
        await json("/api/work-live-tasks/stop", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "stop-work-live-tasks", threadId }),
        }),
      ),
    nativeSessions: async (threadId) => {
      const query = new URLSearchParams({ threadId: String(threadId) });
      const listed = decodeHostAnswer(WorkNativeSessions)(
        await json(`/api/work-native-sessions?${query}`, { headers, cache: "no-store" }),
      );
      if (String(listed.threadId) !== String(threadId))
        throw new Error("The host returned another thread's sessions.");
      return listed;
    },
    adoptNativeSession: async (threadId, nativeSessionId) =>
      decodeHostAnswer(AdoptWorkNativeSessionResult)(
        await json("/api/work-native-sessions/adopt", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ kind: "adopt-work-native-session", threadId, nativeSessionId }),
        }),
      ),
  };
}
