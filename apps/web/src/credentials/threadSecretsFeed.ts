import { useCallback, useSyncExternalStore } from "react";
import {
  createThreadSecretsClient,
  type ThreadSecretReply,
  type ThreadSecretsClient,
} from "@octant/client-runtime/thread-secrets-client";
import type { ThreadSecretCommand, ThreadSecretsView } from "@octant/contracts/thread-secrets";
import { waitUntilDocumentVisible } from "../polling/documentVisibility";

const REFRESH_MS = 1_000;
const LONGEST_RETRY_MS = 15_000;

export interface ThreadSecretsState {
  readonly view: ThreadSecretsView;
  /** The host could not be reached: what is shown may be out of date. */
  readonly unavailable: boolean;
}

const NOTHING: ThreadSecretsState = { view: { requests: [], active: [] }, unavailable: false };

/** One thread's secrets, read once for every surface that shows them. */
class ThreadSecretsFeed {
  readonly #client: ThreadSecretsClient;
  readonly #threadId: string;
  readonly #listeners = new Set<() => void>();
  #state = NOTHING;
  #abort: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wait = REFRESH_MS;

  constructor(client: ThreadSecretsClient, threadId: string) {
    this.#client = client;
    this.#threadId = threadId;
  }

  get state(): ThreadSecretsState {
    return this.#state;
  }

  /** The last listener to leave ends the reading; whether it was the last. */
  subscribe(listener: () => void): () => boolean {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#refresh();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) return false;
      this.#stop();
      return true;
    };
  }

  async execute(command: ThreadSecretCommand): Promise<ThreadSecretReply> {
    try {
      return await this.#client.execute(command);
    } finally {
      if (this.#listeners.size > 0) this.#refresh();
    }
  }

  #stop(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    clearTimeout(this.#timer);
  }

  #refresh(): void {
    this.#stop();
    const abort = new AbortController();
    this.#abort = abort;
    void this.#read(abort.signal).then(() => {
      if (!abort.signal.aborted) this.#timer = setTimeout(() => this.#refresh(), this.#wait);
    });
  }

  async #read(signal: AbortSignal): Promise<void> {
    await waitUntilDocumentVisible(signal);
    if (signal.aborted) return;
    try {
      const view = await this.#client.read(this.#threadId, signal);
      if (signal.aborted) return;
      this.#wait = REFRESH_MS;
      this.#set({ view, unavailable: false });
    } catch {
      if (signal.aborted) return;
      this.#wait = Math.min(this.#wait * 2, LONGEST_RETRY_MS);
      this.#set({ view: this.#state.view, unavailable: true });
    }
  }

  #set(state: ThreadSecretsState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

const feeds = new Map<string, ThreadSecretsFeed>();

export interface ThreadSecretsPort extends ThreadSecretsState {
  readonly send: (command: ThreadSecretCommand) => Promise<ThreadSecretReply>;
}

/** One thread's secret cards and active secrets, from this window's own host. */
export function useThreadSecrets(input: {
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}): ThreadSecretsPort {
  const { threadId, serverUrl, windowCapability } = input;
  const subscribe = useCallback(
    (listener: () => void) => {
      const feed = feedOf(threadId, serverUrl, windowCapability);
      if (feed === undefined) return () => undefined;
      const { key, value } = feed;
      feeds.set(key, value);
      const leave = value.subscribe(listener);
      return () => {
        if (leave()) feeds.delete(key);
      };
    },
    [threadId, serverUrl, windowCapability],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => feeds.get(keyOf(threadId, serverUrl, windowCapability))?.state ?? NOTHING,
  );
  const send = async (command: ThreadSecretCommand): Promise<ThreadSecretReply> => {
    const feed = feedOf(threadId, serverUrl, windowCapability);
    return feed === undefined ? { status: "gone" } : feed.value.execute(command);
  };
  return { ...state, send };
}

function keyOf(
  threadId: string,
  serverUrl: string | undefined,
  windowCapability: string | undefined,
): string {
  return JSON.stringify([threadId, serverUrl, windowCapability]);
}

function feedOf(
  threadId: string,
  serverUrl: string | undefined,
  windowCapability: string | undefined,
): { readonly key: string; readonly value: ThreadSecretsFeed } | undefined {
  if (serverUrl === undefined || windowCapability === undefined) return undefined;
  const key = keyOf(threadId, serverUrl, windowCapability);
  const value = feeds.get(key);
  if (value !== undefined) return { key, value };
  try {
    const client = createThreadSecretsClient({
      baseUrl: serverUrl,
      windowCapability,
      fetch: (...request) => globalThis.fetch(...request),
    });
    return { key, value: new ThreadSecretsFeed(client, threadId) };
  } catch {
    return undefined;
  }
}
