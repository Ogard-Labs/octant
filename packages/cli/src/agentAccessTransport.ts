import { createListenerFetch } from "@octant/client-runtime/remote-listener-tls-node";

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export interface AgentListenerTarget {
  readonly origin: string;
  /** `sha256-<base64url SPKI hash>`; absent, the system's authorities judge the certificate. */
  readonly pin?: string;
}

export interface AgentListenerResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export type AgentListenerFetch = (input: {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (frame: string) => void;
}) => Promise<AgentListenerResponse>;

/**
 * POSTs to another host's private listener through the same connection a
 * paired device uses, so one place judges the address and the certificate:
 * only an address on the person's own network, and with a pin, only the
 * certificate key the connection code named. Without a pin (the person serves
 * their own certificate, such as a Tailscale one), the system's authorities
 * and the host name judge it. A refusal throws before any request byte leaves.
 */
export function agentListenerFetch(target: AgentListenerTarget): AgentListenerFetch {
  const listenerFetch = createListenerFetch({
    origin: new URL(target.origin).origin,
    trust: {
      current:
        target.pin === undefined ? { kind: "platform" } : { kind: "pinned", pin: target.pin },
    },
  });
  return async ({ path, headers, body, signal, onEvent }) => {
    const response = await listenerFetch(new URL(path, target.origin), {
      method: "POST",
      headers,
      body,
      ...(signal === undefined ? {} : { signal }),
    });
    return await readResponse(response, onEvent, signal);
  };
}

/**
 * POSTs to the agent endpoint of the host on this computer, over its loopback
 * server: the path an MCP client here takes with a key it joined with as a
 * bridge does. The request carries the same signed proof and nothing else; the
 * host's local secret is never read or sent. An origin that is not a loopback
 * address is refused before any request byte leaves.
 */
export function agentLoopbackFetch(origin: string): AgentListenerFetch {
  const target = new URL(origin);
  const loopback =
    target.protocol === "http:" &&
    (target.hostname === "127.0.0.1" ||
      target.hostname === "localhost" ||
      target.hostname === "[::1]");
  return async ({ path, headers, body, signal, onEvent }) => {
    if (!loopback) throw new Error("Octant's address on this computer is not a loopback address.");
    const response = await fetch(new URL(path, target.origin), {
      method: "POST",
      headers,
      body,
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    return await readResponse(response, onEvent, signal);
  };
}

async function readResponse(
  response: Response,
  onEvent?: (frame: string) => void,
  signal?: AbortSignal,
): Promise<AgentListenerResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    onEvent !== undefined &&
    response.status === 200 &&
    contentType.includes("text/event-stream") &&
    response.body !== null
  ) {
    await streamEvents(response.body, onEvent, signal);
    return { status: response.status, contentType, body: "" };
  }
  return { status: response.status, contentType, body: await boundedText(response) };
}

async function streamEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (frame: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted === true) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (boundary === null) break;
        if (boundary.index > MAX_RESPONSE_BYTES)
          throw new Error("The listener's event was too large.");
        onEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (buffer.length > MAX_RESPONSE_BYTES)
        throw new Error("The listener's event was too large.");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
  }
}

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The listener's answer was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
