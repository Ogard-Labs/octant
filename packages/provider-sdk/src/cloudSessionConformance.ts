import { decodeProviderModelId } from "@octant/contracts";
import {
  decodeProviderCloudJobId,
  decodeProviderCloudRemoteId,
  ProviderCloudObservation,
} from "@octant/contracts/provider-cloud-sessions";
import { Schema } from "effect";
import {
  CloudSessionRequestRefused,
  type CloudSessionAdapter,
  type CloudSessionPorts,
} from "./cloudSessions";

/** Synthetic first-protocol acceptance; never contacts a provider or reads a credential. */
export async function runCloudSessionConformance(input: {
  readonly createAdapter: (ports: CloudSessionPorts) => CloudSessionAdapter;
}): Promise<{ readonly cases: ReadonlyArray<string> }> {
  const remoteId = decodeProviderCloudRemoteId("sess_conformance");
  const command = {
    jobId: decodeProviderCloudJobId("a7550000-0000-4000-8000-000000000099"),
    modelId: decodeProviderModelId("conformance-model"),
    text: "Only this synthetic text was reviewed.",
  };
  const adapter = input.createAdapter({
    current: () => true,
    request: async (request) => {
      if (request.path === "/v1/agents/sessions") {
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            input: Schema.Literal(command.text),
            review: Schema.Literal("none"),
            stream: Schema.Literal(false),
            agent: Schema.Struct({
              model: Schema.Literal(command.modelId),
              tools: Schema.Tuple(),
              multi_agent: Schema.Struct({ enabled: Schema.Literal(false) }),
            }),
            environment: Schema.Struct({
              type: Schema.Literal("openai_hosted"),
              network: Schema.Struct({ access: Schema.Literal("disabled") }),
              files: Schema.Tuple(),
              env: Schema.Record({ key: Schema.String, value: Schema.Never }),
              setup_commands: Schema.Tuple(),
              plugins: Schema.Tuple(),
              desktop: Schema.Struct({ enabled: Schema.Literal(false) }),
            }),
          }),
        )(JSON.parse(request.body ?? "null"));
        if (body.input !== command.text || request.method !== "POST")
          throw new Error("Cloud input was changed.");
        return Response.json({ id: remoteId, status: "in_progress" });
      }
      if (request.path === `/v1/agents/sessions/${remoteId}`)
        return Response.json({ id: remoteId, status: "idle", required_actions: [] });
      if (request.path === `/v1/agents/sessions/${remoteId}/turns?order=desc&limit=1`)
        return Response.json({ data: [{ id: "turn_conformance", status: "completed" }] });
      if (request.path === `/v1/agents/sessions/${remoteId}/items?order=desc&limit=100`)
        return Response.json({
          data: [
            {
              id: "item_conformance",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Synthetic cloud result." }],
            },
          ],
          has_more: false,
        });
      if (request.path === `/v1/agents/sessions/${remoteId}/events` && request.method === "POST")
        return Response.json({});
      throw new Error("Cloud adapter left the owned session.");
    },
  });
  const created = Schema.decodeUnknownSync(ProviderCloudObservation)(await adapter.create(command));
  if (created.status !== "observed" || created.remoteId !== remoteId || created.state !== "running")
    throw new Error("Cloud create was not normalized.");
  const read = Schema.decodeUnknownSync(ProviderCloudObservation)(await adapter.read(remoteId));
  if (
    read.status !== "observed" ||
    read.state !== "completed" ||
    read.output !== "Synthetic cloud result."
  )
    throw new Error("Cloud terminal output was not normalized.");
  if ((await adapter.cancel(remoteId, command.jobId)).status !== "requested")
    throw new Error("Cloud cancellation was overstated.");
  let attempts = 0;
  const lost = input.createAdapter({
    current: () => true,
    request: async () => {
      attempts += 1;
      throw new Error("Synthetic lost reply.");
    },
  });
  if ((await lost.create(command)).status !== "uncertain" || attempts !== 1)
    throw new Error("An uncertain create was retried or hidden.");
  const revoked = input.createAdapter({
    current: () => false,
    request: async () => {
      throw new CloudSessionRequestRefused();
    },
  });
  if ((await revoked.create(command)).status !== "unavailable")
    throw new Error("A known pre-dispatch refusal was hidden.");
  return {
    cases: [
      "exact reviewed text and disabled remote network",
      "known session and actual terminal turn",
      "cancellation acknowledgement is not completion",
      "uncertain create is not retried",
      "pre-dispatch refusal is unavailable",
    ],
  };
}
