import type { CloudSessionHttpRequest, CloudSessionIntent } from "./cloudSessions";
import { ProviderCloudRemoteId } from "@octant/contracts/provider-cloud-sessions";
import { Schema } from "effect";

/** Exact official endpoint, permitting only a suffix of trailing slashes. */
export function isOpenAiCloudSessionBaseUrl(value: string): boolean {
  const base = "https://api.openai.com/v1";
  if (!value.startsWith(base)) return false;
  for (let index = base.length; index < value.length; index += 1) {
    if (value[index] !== "/") return false;
  }
  return true;
}

export function openAiCreatedCloudSessionId(
  body: string,
): typeof ProviderCloudRemoteId.Type | undefined {
  try {
    const parsed = Schema.decodeUnknownOption(Schema.Struct({ id: ProviderCloudRemoteId }))(
      JSON.parse(body),
    );
    return parsed._tag === "Some" ? parsed.value.id : undefined;
  } catch {
    return undefined;
  }
}

/** The first supported cloud wire; third-party drivers use this same closed codec. */
export function openAiCloudSessionRequests(
  intent: CloudSessionIntent,
): ReadonlyArray<CloudSessionHttpRequest> {
  const headers = { "OpenAI-Beta": "agents=v1" };
  if (intent.kind === "create")
    return [
      {
        path: "/v1/agents/sessions",
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: { model: intent.modelId, tools: [], multi_agent: { enabled: false } },
          environment: {
            type: "openai_hosted",
            container_size: "small",
            network: { access: "disabled" },
            desktop: { enabled: false },
            env: {},
            files: [],
            setup_commands: [],
            plugins: [],
            capability_directories: [],
          },
          input: intent.text,
          stream: false,
          review: "none",
          metadata: { octant_job: intent.jobId },
        }),
      },
    ];
  const root = `/v1/agents/sessions/${encodeURIComponent(intent.remoteId)}`;
  if (intent.kind === "cancel")
    return [
      {
        path: `${root}/events`,
        method: "POST",
        headers,
        body: JSON.stringify({
          idempotency_key: `octant-cancel-${intent.jobId}`,
          events: [{ type: "agent.session.input.cancel" }],
        }),
      },
    ];
  return [root, `${root}/turns?order=desc&limit=1`, `${root}/items?order=desc&limit=100`].map(
    (path) => ({ path, method: "GET" as const, headers }),
  );
}
