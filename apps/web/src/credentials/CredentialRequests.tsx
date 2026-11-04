import { useEffect, useState } from "react";
import { Schema } from "effect";
import {
  CredentialRequestView,
  type CredentialRequestAnswer,
} from "@octant/contracts/credential-request";
import { CredentialRequestCard } from "./CredentialRequestCard";

export function CredentialRequests(props: {
  readonly threadId: string;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
}) {
  const [view, setView] = useState<CredentialRequestView>({ requests: [] });
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setView({ requests: [] });
    setUnavailable(false);
    if (props.serverUrl === undefined || props.windowCapability === undefined) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const url = endpoint(props.serverUrl, props.threadId);
        if (url === undefined) return;
        const response = await fetch(url, {
          headers: { "x-octant-window-capability": props.windowCapability ?? "" },
          signal: abort.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("unavailable");
        const next = Schema.decodeUnknownSync(CredentialRequestView)(await response.json());
        if (!abort.signal.aborted) {
          setView(next);
          setUnavailable(false);
        }
      } catch {
        if (!abort.signal.aborted) setUnavailable(true);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 1000);
      }
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [props.threadId, props.serverUrl, props.windowCapability]);

  const answer = async (value: CredentialRequestAnswer) => {
    const url = endpoint(props.serverUrl);
    if (url === undefined || props.windowCapability === undefined || unavailable) return false;
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": props.windowCapability,
      },
      body: JSON.stringify(value),
    });
    const body: unknown = await response.json();
    return (
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      "status" in body &&
      body.status === "accepted"
    );
  };
  if (view.requests.length === 0) return null;
  return (
    <div className="thread-column credential-requests" aria-label="Credential requests">
      {unavailable ? (
        <p role="status">Credential request status is unavailable. Reconnecting…</p>
      ) : (
        view.requests.map((card) => (
          <CredentialRequestCard key={card.id} card={card} answer={answer} />
        ))
      )}
    </div>
  );
}

function endpoint(serverUrl: string | undefined, threadId?: string): string | undefined {
  if (serverUrl === undefined) return undefined;
  try {
    const url = new URL("/api/credential-requests", serverUrl);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return undefined;
    if (threadId !== undefined) url.searchParams.set("threadId", threadId);
    return url.toString();
  } catch {
    return undefined;
  }
}
