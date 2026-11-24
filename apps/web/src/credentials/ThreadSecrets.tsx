import { useEffect, useState } from "react";
import {
  decodeThreadSecretCommandResult,
  decodeThreadSecretsView,
  type ThreadSecretAnswer,
  type ThreadSecretCommand,
  type ThreadSecretsView,
} from "@octant/contracts/thread-secrets";
import { waitUntilDocumentVisible } from "../polling/documentVisibility";
import { ThreadSecretCard, type ThreadSecretReply } from "./ThreadSecretCard";

const NOTHING: ThreadSecretsView = { requests: [], active: [] };
const REFRESH_MS = 1_000;
const LONGEST_RETRY_MS = 15_000;

export interface ThreadSecretsPort {
  readonly view: ThreadSecretsView;
  /** The host could not be reached: what is shown may be out of date. */
  readonly unavailable: boolean;
  readonly send: (command: ThreadSecretCommand) => Promise<ThreadSecretReply>;
}

/** One thread's secret cards and active secrets, from this window's own host. */
export function useThreadSecrets(input: {
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}): ThreadSecretsPort {
  const { threadId, serverUrl, windowCapability } = input;
  const [view, setView] = useState<ThreadSecretsView>(NOTHING);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setView(NOTHING);
    setUnavailable(false);
    const url = endpoint(serverUrl, threadId);
    if (url === undefined || windowCapability === undefined) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wait = REFRESH_MS;
    const refresh = async () => {
      await waitUntilDocumentVisible(abort.signal);
      if (abort.signal.aborted) return;
      try {
        const response = await fetch(url, {
          headers: { "x-octant-window-capability": windowCapability },
          signal: abort.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("unavailable");
        const next = decodeThreadSecretsView(await response.json());
        if (abort.signal.aborted) return;
        setView(next);
        setUnavailable(false);
        wait = REFRESH_MS;
      } catch {
        if (!abort.signal.aborted) setUnavailable(true);
        wait = Math.min(wait * 2, LONGEST_RETRY_MS);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), wait);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [threadId, serverUrl, windowCapability]);

  const send = async (command: ThreadSecretCommand): Promise<ThreadSecretReply> => {
    const url = endpoint(serverUrl);
    if (url === undefined || windowCapability === undefined) return { status: "gone" };
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": windowCapability,
      },
      body: JSON.stringify(command),
    });
    // The host refuses a request before it reads an answer from it.
    if (response.status >= 400 && response.status < 500) return { status: "not-taken" };
    if (!response.ok) throw new Error("The host did not take the answer.");
    return decodeThreadSecretCommandResult(await response.json());
  };
  return { view, unavailable, send };
}

/** The cards an agent's requests wait in, at the end of the conversation. */
export function ThreadSecrets(props: {
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}) {
  const { threadId } = props;
  const { view, unavailable, send } = useThreadSecrets(props);
  if (view.requests.length === 0) return null;
  const answer = (value: ThreadSecretAnswer) => send({ kind: "answer", threadId, answer: value });
  return (
    <div className="thread-column thread-secrets" aria-label="Secret requests">
      {unavailable ? <p role="status">Octant is reconnecting to this computer.</p> : null}
      {view.requests.map((card) => (
        <ThreadSecretCard key={card.id} card={card} answer={answer} />
      ))}
    </div>
  );
}

/** Only this computer's own host: a secret is sent nowhere else. */
function endpoint(serverUrl: string | undefined, threadId?: string): string | undefined {
  if (serverUrl === undefined) return undefined;
  try {
    const url = new URL("/api/thread-secrets", serverUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return undefined;
    if (threadId !== undefined) url.searchParams.set("threadId", threadId);
    return url.toString();
  } catch {
    return undefined;
  }
}
