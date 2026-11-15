import {
  decodeHostAnswer,
  ThreadWakeupCommandResult,
  ThreadWakeupList,
  type ThreadWakeup,
  type ThreadWakeupCommand,
  type ThreadWakeupMode,
} from "@octant/contracts";

export interface ThreadWakeupClient {
  readonly list: (mode: ThreadWakeupMode, threadId: string) => Promise<ReadonlyArray<ThreadWakeup>>;
  readonly execute: (command: ThreadWakeupCommand) => Promise<ThreadWakeupCommandResult>;
}

export function createThreadWakeupClient(options: {
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly fetch?: typeof fetch;
}): ThreadWakeupClient {
  const request = options.fetch ?? globalThis.fetch;
  const base = options.serverUrl.replace(/\/$/, "");
  const headers = { "x-octant-window-capability": options.windowCapability };
  async function json(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(`${base}${path}`, {
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    if (!response.ok) throw new Error("The host's wake-ups are unavailable.");
    return await response.json();
  }
  return {
    list: async (mode, threadId) => {
      const query = new URLSearchParams({ mode, threadId });
      const { wakeups } = decodeHostAnswer(ThreadWakeupList)(
        await json(`/api/thread-wakeups?${query}`, { headers, cache: "no-store" }),
      );
      if (wakeups.some((wakeup) => wakeup.mode !== mode || wakeup.threadId !== threadId)) {
        throw new Error("The host returned another thread's wake-ups.");
      }
      return wakeups;
    },
    execute: async (command) =>
      decodeHostAnswer(ThreadWakeupCommandResult)(
        await json("/api/thread-wakeups/commands", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(command),
        }),
      ),
  };
}
