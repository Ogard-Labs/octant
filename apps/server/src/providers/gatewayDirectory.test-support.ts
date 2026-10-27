import {
  decodeDirectoryIssuer,
  decodeDirectoryIssuerClientId,
  decodeDirectoryResourceScope,
  type AnthropicCompatibleProviderConfiguration,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderModelId,
} from "@octant/contracts";
import {
  encodeDirectoryOAuthCredential,
  sameDirectoryOAuthBinding,
  type DirectoryOAuthBinding,
  type DirectoryOAuthHost,
} from "@octant/provider-sdk/directory-oauth";
import { chatStream } from "./foundryDirectory.test-support";

/**
 * An OpenAI-compatible or Anthropic-compatible gateway signed in with its
 * organization's own issuer, and a broker that holds its grant, for driver
 * tests that need no real identity provider.
 */

export const GATEWAY_ISSUER = decodeDirectoryIssuer("https://login.example.test/oauth2/gateway");
export const GATEWAY_CLIENT = decodeDirectoryIssuerClientId("0oa1octantDesktop");
export const GATEWAY_SCOPE = decodeDirectoryResourceScope("gateway.models");
export const GATEWAY_ORIGIN = "https://llm.example.test";
export const GATEWAY_MODEL = "gateway-model" as ProviderModelId;
const CREDENTIAL_REF = "6a1f0b2c-3d4e-4f5a-8b9c-0d1e2f3a4b5c";

const directory = { issuer: GATEWAY_ISSUER, clientId: GATEWAY_CLIENT, scope: GATEWAY_SCOPE };

export function openAiGatewayConfiguration(): Extract<
  OpenAiCompatibleProviderConfiguration,
  { readonly authentication: "directory-oauth" }
> {
  return {
    kind: "openai-compatible-http",
    baseUrl: `${GATEWAY_ORIGIN}/v1/`,
    authentication: "directory-oauth",
    protocol: "chat-completions",
    manualModelIds: [GATEWAY_MODEL],
    directory,
  };
}

export function anthropicGatewayConfiguration(): Extract<
  AnthropicCompatibleProviderConfiguration,
  { readonly authentication: "directory-oauth" }
> {
  return {
    kind: "anthropic-compatible-http",
    baseUrl: `${GATEWAY_ORIGIN}/anthropic/v1/`,
    authentication: "directory-oauth",
    protocol: "messages",
    protocolVersion: "2023-06-01",
    manualModelIds: [GATEWAY_MODEL],
    directory,
  };
}

const BINDING: DirectoryOAuthBinding = { ...directory, endpointOrigin: GATEWAY_ORIGIN };

/** The pointer the store holds for a signed-in gateway. */
export const GATEWAY_POINTER = encodeDirectoryOAuthCredential({
  kind: "directory-oauth",
  credentialRef: CREDENTIAL_REF,
  ...BINDING,
  accountLabel: "ada@example.test",
});

/**
 * A broker holding one grant for the gateway binding. Each refresh issues a
 * new token; `access` releases the current one only under the exact binding.
 */
export class GatewayGrantBroker implements DirectoryOAuthHost {
  #generation = 1;
  #refreshes = 0;
  readonly #issued: string[] = ["gateway-directory-token-1"];

  get refreshes(): number {
    return this.#refreshes;
  }

  /** Every token the broker has released, so a test can look for each one. */
  get issued(): ReadonlyArray<string> {
    return [...this.#issued];
  }

  current(): string {
    return `gateway-directory-token-${this.#generation}`;
  }

  readonly refresh: DirectoryOAuthHost["refresh"] = async (credentialRef) => {
    if (credentialRef !== CREDENTIAL_REF) return { kind: "sign-in-again", reason: "expired" };
    this.#refreshes += 1;
    this.#generation += 1;
    this.#issued.push(this.current());
    return { kind: "refreshed" };
  };

  readonly access: DirectoryOAuthHost["access"] = async (credentialRef, binding) => {
    if (credentialRef !== CREDENTIAL_REF) return { kind: "sign-in-again", reason: "expired" };
    if (!sameDirectoryOAuthBinding(binding, BINDING)) return { kind: "binding-mismatch" };
    return { kind: "granted", accessToken: this.current(), expiresAt: "2099-01-01T00:00:00.000Z" };
  };
}

/**
 * A gateway that answers only the broker's current bearer, with a model list
 * or a streamed answer in the protocol the path names; a stored key is
 * refused outright. `refuse` answers every request with a response of the
 * test's choosing instead.
 */
export function gatewayEndpoint(
  broker: GatewayGrantBroker,
  options: { readonly reply?: string; readonly refuse?: () => Response | undefined } = {},
): ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
  readonly authorizations: ReadonlyArray<string>;
} {
  const authorizations: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    authorizations.push(authorization);
    if (headers.has("x-api-key") || headers.has("api-key")) {
      return Response.json({ error: "unexpected key" }, { status: 400 });
    }
    const refused = options.refuse?.();
    if (refused !== undefined) return refused;
    if (authorization !== `Bearer ${broker.current()}`) {
      return Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
    }
    const url = String(input);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: GATEWAY_MODEL }] });
    const reply = options.reply ?? "Hello from the gateway.";
    return url.endsWith("/messages") ? messagesStream(reply) : chatStream(reply);
  };
  return Object.assign(fetch, { authorizations });
}

/** A streamed Anthropic Messages answer carrying `text`. */
export function messagesStream(text: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: GATEWAY_MODEL,
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
