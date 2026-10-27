import {
  decodeDirectoryClientId,
  decodeDirectoryTenantId,
  type AzureFoundryProviderConfiguration,
  type ProviderModelId,
} from "@octant/contracts";
import { AZURE_FOUNDRY_DIRECTORY_SIGN_IN } from "@octant/domain";
import {
  encodeDirectoryOAuthCredential,
  type DirectoryOAuthBinding,
  type DirectoryOAuthHost,
} from "@octant/provider-sdk/directory-oauth";
import type { CompatibleFetch } from "./openAiCompatibleEndpoint";

/**
 * An Azure AI Foundry instance signed in with an organization account, and a
 * broker that holds its grant, for driver tests that need no real directory.
 */

export const FOUNDRY_TENANT = decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
export const FOUNDRY_CLIENT = decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d");
export const FOUNDRY_BASE_URL = "https://contoso.openai.azure.com/openai/v1/";
export const FOUNDRY_ORIGIN = "https://contoso.openai.azure.com";
export const FOUNDRY_DEPLOYMENT = "deployment-fixture" as ProviderModelId;
const CREDENTIAL_REF = "5e0f6a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b";

export function foundryDirectoryConfiguration(
  protocol: AzureFoundryProviderConfiguration["protocol"] = "chat-completions",
): Extract<AzureFoundryProviderConfiguration, { readonly authentication: "directory-oauth" }> {
  return {
    kind: "azure-foundry-openai-http",
    baseUrl: FOUNDRY_BASE_URL,
    authentication: "directory-oauth",
    protocol,
    manualModelIds: [FOUNDRY_DEPLOYMENT],
    directory: { tenantId: FOUNDRY_TENANT, clientId: FOUNDRY_CLIENT },
  };
}

/** The pointer the store holds for the signed-in instance. */
export const FOUNDRY_POINTER = encodeDirectoryOAuthCredential({
  kind: "directory-oauth",
  credentialRef: CREDENTIAL_REF,
  tenantId: FOUNDRY_TENANT,
  clientId: FOUNDRY_CLIENT,
  audience: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience,
  endpointOrigin: FOUNDRY_ORIGIN,
  accountLabel: "person@contoso.example",
});

/**
 * A broker holding one grant for the Foundry binding. Each refresh issues a
 * new token; `access` releases the current one only under the exact binding.
 */
export class FoundryGrantBroker implements DirectoryOAuthHost {
  #generation = 1;
  #refreshes = 0;
  readonly #issued: string[] = ["foundry-directory-token-1"];

  get refreshes(): number {
    return this.#refreshes;
  }

  /** Every token the broker has released, so a test can look for each one. */
  get issued(): ReadonlyArray<string> {
    return [...this.#issued];
  }

  current(): string {
    return `foundry-directory-token-${this.#generation}`;
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
    if (!matchesFoundryBinding(binding)) return { kind: "binding-mismatch" };
    return {
      kind: "granted",
      accessToken: this.current(),
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  };
}

function matchesFoundryBinding(binding: DirectoryOAuthBinding): boolean {
  return (
    "tenantId" in binding &&
    String(binding.tenantId) === String(FOUNDRY_TENANT) &&
    String(binding.clientId) === String(FOUNDRY_CLIENT) &&
    binding.audience === AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience &&
    binding.endpointOrigin === FOUNDRY_ORIGIN
  );
}

/**
 * A Foundry endpoint that answers only the broker's current bearer: a model
 * list, or a streamed chat completion. `refuse` answers every request with a
 * status and body of the test's choosing instead.
 */
export function foundryEndpoint(
  broker: FoundryGrantBroker,
  options: {
    readonly reply?: string;
    readonly refuse?: () => Response | undefined;
  } = {},
): CompatibleFetch & { readonly authorizations: ReadonlyArray<string> } {
  const authorizations: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    authorizations.push(authorization);
    if (headers.has("api-key")) return Response.json({ error: "unexpected key" }, { status: 400 });
    const refused = options.refuse?.();
    if (refused !== undefined) return refused;
    if (authorization !== `Bearer ${broker.current()}`) {
      return Response.json({ error: { code: "401", message: "Unauthorized" } }, { status: 401 });
    }
    if (String(input).endsWith("/models")) {
      return Response.json({ data: [{ id: FOUNDRY_DEPLOYMENT }] });
    }
    return chatStream(options.reply ?? "Hello from Foundry.");
  };
  return Object.assign(fetch, { authorizations });
}

/** A streamed chat completion carrying `text`. */
export function chatStream(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
      usage: null,
    },
    {
      id: "chatcmpl_fixture",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    },
    "[DONE]",
  ];
  return new Response(
    chunks
      .map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
