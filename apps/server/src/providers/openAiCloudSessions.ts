import { Schema } from "effect";
import { openAiCloudSessionRequests } from "@octant/provider-sdk/openai-cloud-session-protocol";
import { CloudSessionRequestRefused } from "@octant/provider-sdk/cloud-sessions";
import type { ProviderInstance } from "@octant/contracts";
import {
  MAX_PROVIDER_CLOUD_OUTPUT,
  ProviderCloudRemoteId,
} from "@octant/contracts/provider-cloud-sessions";
import type {
  CloudSessionAdapter,
  CloudSessionDriver,
  CloudSessionObservation,
} from "@octant/provider-sdk/cloud-sessions";

const session = Schema.Struct({
  id: ProviderCloudRemoteId,
  status: Schema.Literal("idle", "in_progress", "requires_action", "failed"),
  required_actions: Schema.optional(Schema.Array(Schema.Unknown)),
});
const turns = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: ProviderCloudRemoteId,
      status: Schema.Literal(
        "queued",
        "in_progress",
        "waiting",
        "completed",
        "failed",
        "cancelled",
      ),
    }),
  ).pipe(Schema.maxItems(1)),
});
const itemList = Schema.Struct({
  data: Schema.Array(Schema.Unknown).pipe(Schema.maxItems(100)),
  has_more: Schema.Boolean,
});
const assistantMessage = Schema.Struct({
  id: ProviderCloudRemoteId,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown).pipe(Schema.maxItems(256)),
});
const outputText = Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String });
const headers = { "OpenAI-Beta": "agents=v1" };

export function makeOpenAiCloudSessionAdapter(
  input: Parameters<CloudSessionDriver["create"]>[0],
): CloudSessionAdapter {
  const request = input.ports.request;
  return {
    async create(command) {
      try {
        const planned = openAiCloudSessionRequests({
          kind: "create",
          jobId: command.jobId,
          modelId: command.modelId,
          text: command.text,
        })[0];
        if (planned === undefined) return { status: "unavailable" };
        const response = await request({
          ...planned,
          ...(command.signal === undefined ? {} : { signal: command.signal }),
        });
        if (!response.ok)
          return response.status < 500 ? { status: "unavailable" } : { status: "uncertain" };
        const decoded = Schema.decodeUnknownOption(session)(await response.json());
        if (decoded._tag === "None") return { status: "uncertain" };
        return {
          status: "observed",
          remoteId: decoded.value.id,
          state: "running",
          output: "",
          truncated: false,
        };
      } catch (error) {
        if (error instanceof CloudSessionRequestRefused) return { status: "unavailable" };
        // A request may already have created a billed remote session. It is never retried.
        return { status: "uncertain" };
      }
    },
    async read(remoteId, signal) {
      const root = `/v1/agents/sessions/${encodeURIComponent(remoteId)}`;
      const get = (path: string) =>
        request({ path, method: "GET", headers, ...(signal === undefined ? {} : { signal }) });
      try {
        const response = await get(root);
        if (!response.ok) return { status: "unavailable" };
        const decoded = Schema.decodeUnknownOption(session)(await response.json());
        if (decoded._tag === "None" || String(decoded.value.id) !== String(remoteId))
          return { status: "unavailable" };
        if (
          decoded.value.status === "requires_action" ||
          (decoded.value.required_actions?.length ?? 0) > 0
        )
          return { status: "unsupported" };
        const turnResponse = await get(`${root}/turns?order=desc&limit=1`);
        if (!turnResponse.ok) return { status: "unavailable" };
        const turnList = Schema.decodeUnknownOption(turns)(await turnResponse.json());
        if (turnList._tag === "None") return { status: "unavailable" };
        const status = turnList.value.data[0]?.status;
        const state =
          status === "completed" || status === "failed" || status === "cancelled"
            ? status
            : decoded.value.status === "failed"
              ? "failed"
              : "running";
        const itemsResponse = await get(`${root}/items?order=desc&limit=100`);
        if (!itemsResponse.ok) return { status: "unavailable" };
        const items = Schema.decodeUnknownOption(itemList)(await itemsResponse.json());
        if (items._tag === "None") return { status: "unavailable" };
        const seen = new Set<string>();
        const text: string[] = [];
        let length = 0;
        let truncated = items.value.has_more;
        for (const item of [...items.value.data].reverse()) {
          const message = Schema.decodeUnknownOption(assistantMessage)(item);
          if (message._tag === "None" || seen.has(message.value.id)) continue;
          seen.add(message.value.id);
          for (const part of message.value.content) {
            const output = Schema.decodeUnknownOption(outputText)(part);
            if (output._tag === "None") continue;
            const available = Math.max(
              0,
              MAX_PROVIDER_CLOUD_OUTPUT - length - (text.length > 0 ? 1 : 0),
            );
            const value = output.value.text.slice(0, available);
            if (value !== output.value.text) truncated = true;
            if (value.length > 0) {
              text.push(value);
              length += value.length + (text.length > 1 ? 1 : 0);
            }
          }
        }
        return {
          status: "observed",
          remoteId,
          state,
          output: text.join("\n"),
          truncated,
        } satisfies CloudSessionObservation;
      } catch {
        return { status: "unavailable" };
      }
    },
    async cancel(remoteId, jobId, signal) {
      try {
        const planned = openAiCloudSessionRequests({ kind: "cancel", remoteId, jobId })[0];
        if (planned === undefined) return { status: "unavailable" };
        const response = await request({ ...planned, ...(signal === undefined ? {} : { signal }) });
        return { status: response.ok ? "requested" : "uncertain" };
      } catch {
        return { status: "uncertain" };
      }
    },
  };
}

export function supportsOpenAiCloudSessions(instance: ProviderInstance): boolean {
  if (instance.driverKind !== "openai-compatible") return false;
  const configuration = instance.configuration;
  return (
    instance.enabled &&
    configuration.authentication === "bearer" &&
    configuration.oauthDescriptorId === undefined &&
    configuration.baseUrl.replace(/\/+$/, "") === "https://api.openai.com/v1"
  );
}

export const openAiCloudSessionDriver: CloudSessionDriver = {
  protocol: "openai-agents-v1",
  supports: supportsOpenAiCloudSessions,
  create: makeOpenAiCloudSessionAdapter,
};
