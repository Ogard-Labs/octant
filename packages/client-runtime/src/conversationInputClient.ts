import {
  decodeConversationInputQuery,
  decodeConversationInputReading,
  type ConversationInputQuery,
  type ConversationInputReading,
} from "@octant/contracts/conversation-inputs";

export function createConversationInputClient(options: {
  readonly baseUrl: string;
  readonly windowCapability?: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  return {
    read: async (
      query: ConversationInputQuery,
      signal?: AbortSignal,
    ): Promise<ConversationInputReading> => {
      const url = new URL("/api/conversation-inputs", options.baseUrl);
      for (const [key, value] of Object.entries(decodeConversationInputQuery(query)))
        url.searchParams.set(key, value);
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        headers:
          options.windowCapability === undefined
            ? {}
            : { "x-octant-window-capability": options.windowCapability },
        ...(signal === undefined ? {} : { signal }),
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("Original inputs are unavailable. Retry while this thread is open.");
      return decodeConversationInputReading(await response.json());
    },
  };
}

export type ConversationInputClient = ReturnType<typeof createConversationInputClient>;
