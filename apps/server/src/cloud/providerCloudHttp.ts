import type { ProviderInstanceId } from "@octant/contracts";
import {
  CloudSessionRequestRefused,
  type CloudSessionPorts,
  type CloudSessionIntent,
} from "@octant/provider-sdk/cloud-sessions";
import {
  openAiCloudSessionRequests,
  openAiCreatedCloudSessionId,
} from "@octant/provider-sdk/openai-cloud-session-protocol";
import type { ProviderCloudRemoteId } from "@octant/contracts/provider-cloud-sessions";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { acquireProviderCredential } from "../providers/providerApiKeyPool";

const MAX_BODY = 2_097_152;

/** An instance-scoped request port; neither the adapter nor renderer receives a credential. */
export function makeProviderCloudPorts(input: {
  readonly instanceId: ProviderInstanceId;
  readonly credentialResolver: ProviderCredentialResolver;
  readonly admission: () => boolean;
  readonly intent: CloudSessionIntent;
  readonly onCreateDispatch?: () => void;
  readonly onCreated?: (remoteId: ProviderCloudRemoteId) => void;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): CloudSessionPorts {
  const planned = openAiCloudSessionRequests(input.intent);
  const consumed = new Set<string>();
  return {
    current: input.admission,
    async request(command) {
      const expected = planned.find(
        (item) =>
          item.path === command.path &&
          item.method === command.method &&
          item.body === command.body,
      );
      const key = `${command.method} ${command.path}`;
      const headersAllowed = Object.entries(command.headers ?? {}).every(
        ([name, value]) =>
          (name.toLowerCase() === "openai-beta" && value === "agents=v1") ||
          (name.toLowerCase() === "content-type" && value === "application/json"),
      );
      if (expected === undefined || !headersAllowed || consumed.has(key) || !input.admission())
        throw new CloudSessionRequestRefused();
      const timeout = AbortSignal.timeout(30_000);
      const signal =
        command.signal === undefined ? timeout : AbortSignal.any([timeout, command.signal]);
      let credential: string;
      const interrupted = Promise.withResolvers<never>();
      const onInterrupted = () => interrupted.reject(new CloudSessionRequestRefused());
      signal.addEventListener("abort", onInterrupted, { once: true });
      if (signal.aborted) onInterrupted();
      try {
        credential = (
          await Promise.race([
            acquireProviderCredential(input.credentialResolver, input.instanceId),
            interrupted.promise,
          ])
        ).credential;
      } catch {
        throw new CloudSessionRequestRefused();
      } finally {
        signal.removeEventListener("abort", onInterrupted);
      }
      // A key unlock can wait. Authority and opt-in must still hold at dispatch.
      if (
        credential.trim().length === 0 ||
        signal.aborted ||
        consumed.has(key) ||
        !input.admission()
      )
        throw new CloudSessionRequestRefused();
      consumed.add(key);
      if (input.intent.kind === "create") {
        try {
          input.onCreateDispatch?.();
        } catch {
          throw new CloudSessionRequestRefused();
        }
      }
      const response = await (input.fetch ?? globalThis.fetch)(
        `https://api.openai.com${expected.path}`,
        {
          method: expected.method,
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            "OpenAI-Beta": "agents=v1",
          },
          ...(expected.body === undefined ? {} : { body: expected.body }),
        },
      );
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader !== undefined) {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_BODY) throw new Error("Cloud reply exceeded its bound.");
            parts.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      if (input.intent.kind === "create" && response.ok) {
        const remoteId = openAiCreatedCloudSessionId(new TextDecoder().decode(bytes));
        if (remoteId !== undefined) input.onCreated?.(remoteId);
      }
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
