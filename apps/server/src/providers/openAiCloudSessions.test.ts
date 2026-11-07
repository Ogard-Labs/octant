import { describe, expect, it } from "vitest";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import {
  decodeProviderCloudJobId,
  decodeProviderCloudRemoteId,
} from "@octant/contracts/provider-cloud-sessions";
import { makeOpenAiCloudSessionAdapter } from "./openAiCloudSessions";
import { runCloudSessionConformance } from "@octant/provider-sdk/cloud-session-conformance";
import { isOpenAiCloudSessionBaseUrl } from "@octant/provider-sdk/openai-cloud-session-protocol";

const jobId = decodeProviderCloudJobId("a7550000-0000-4000-8000-000000000001");
const remoteId = decodeProviderCloudRemoteId("sess_fixture");

describe("OpenAI hosted cloud sessions", () => {
  it("admits only the exact official base with an optional trailing slash suffix", () => {
    expect(isOpenAiCloudSessionBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAiCloudSessionBaseUrl("https://api.openai.com/v1" + "/".repeat(100_000))).toBe(
      true,
    );
    expect(
      isOpenAiCloudSessionBaseUrl("https://api.openai.com/v1" + "/".repeat(100_000) + "other"),
    ).toBe(false);
    expect(isOpenAiCloudSessionBaseUrl("https://api.openai.com.evil.invalid/v1")).toBe(false);
    expect(isOpenAiCloudSessionBaseUrl("https://api.openai.com/v10")).toBe(false);
  });

  it("passes the public cloud-session conformance kit without an account", async () => {
    const result = await runCloudSessionConformance({
      createAdapter: (ports) =>
        makeOpenAiCloudSessionAdapter({
          instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000002"),
          ports,
        }),
    });
    expect(result.cases).toHaveLength(5);
  });
  it("submits only reviewed text into a fresh network-disabled sandbox without host tools", async () => {
    const requests: Array<{ readonly path: string; readonly body: string | undefined }> = [];
    const adapter = makeOpenAiCloudSessionAdapter({
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000002"),
      ports: {
        current: () => true,
        request: async (request) => {
          requests.push({ path: request.path, body: request.body });
          return Response.json({ id: remoteId, status: "in_progress" });
        },
      },
    });
    expect(
      await adapter.create({
        jobId,
        modelId: decodeProviderModelId("fixture-model"),
        text: "Explain this synthetic function.",
      }),
    ).toMatchObject({ status: "observed", remoteId, state: "running" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/agents/sessions");
    expect(JSON.parse(requests[0]?.body ?? "null")).toMatchObject({
      agent: { model: "fixture-model", tools: [], multi_agent: { enabled: false } },
      environment: {
        type: "openai_hosted",
        network: { access: "disabled" },
        files: [],
        env: {},
        desktop: { enabled: false },
        setup_commands: [],
        plugins: [],
        capability_directories: [],
      },
      input: "Explain this synthetic function.",
      review: "none",
      stream: false,
    });
  });

  it("does not retry an uncertain create and never calls a cancellation acknowledgement completed", async () => {
    let creates = 0;
    const adapter = makeOpenAiCloudSessionAdapter({
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000002"),
      ports: {
        current: () => true,
        request: async (request) => {
          if (request.path.endsWith("/events")) return Response.json({ object: "list", data: [] });
          creates += 1;
          throw new Error("synthetic lost reply");
        },
      },
    });
    expect(
      await adapter.create({
        jobId,
        modelId: decodeProviderModelId("fixture-model"),
        text: "synthetic task",
      }),
    ).toEqual({ status: "uncertain" });
    expect(creates).toBe(1);
    expect(await adapter.cancel(remoteId, jobId)).toEqual({ status: "requested" });
  });

  it("uses the actual terminal turn and bounded saved assistant output rather than idle as success", async () => {
    const adapter = makeOpenAiCloudSessionAdapter({
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000002"),
      ports: {
        current: () => true,
        request: async (request) => {
          if (request.path.includes("/turns"))
            return Response.json({ data: [{ id: "turn_fixture", status: "completed" }] });
          if (request.path.includes("/items"))
            return Response.json({
              data: [
                {
                  id: "item_fixture",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "synthetic result" }],
                },
              ],
              has_more: false,
            });
          return Response.json({ id: remoteId, status: "idle", required_actions: [] });
        },
      },
    });
    expect(await adapter.read(remoteId)).toMatchObject({
      status: "observed",
      state: "completed",
      output: "synthetic result",
    });
  });
});
