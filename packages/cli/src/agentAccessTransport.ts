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
  return async ({ path, headers, body, signal }) => {
    const response = await listenerFetch(new URL(path, target.origin), {
      method: "POST",
      headers,
      body,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: await boundedText(response),
    };
  };
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
