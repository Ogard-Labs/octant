import { describe, expect, it } from "vitest";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import {
  decodeProviderCloudJobId,
  decodeProviderCloudRemoteId,
} from "@octant/contracts/provider-cloud-sessions";
import { openAiCloudSessionRequests } from "@octant/provider-sdk/openai-cloud-session-protocol";
import type { CloudSessionIntent } from "@octant/provider-sdk/cloud-sessions";
import { makeProviderCloudPorts } from "./providerCloudHttp";

const intent: CloudSessionIntent = {
  kind: "create",
  jobId: decodeProviderCloudJobId("a7550000-0000-4000-8000-000000000002"),
  modelId: decodeProviderModelId("fixture-model"),
  text: "synthetic reviewed text",
};
const planned = openAiCloudSessionRequests(intent)[0];
if (planned === undefined) throw new Error("Missing cloud fixture request.");

describe("cloud request dispatch", () => {
  it("does not dispatch or record billable uncertainty when the configured key pool has no usable key", async () => {
    let calls = 0;
    let usage = 0;
    const ports = makeProviderCloudPorts({
      intent,
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000001"),
      credentialResolver: { has: async () => false, resolve: async () => "" },
      admission: () => true,
      onCreateDispatch: () => {
        usage += 1;
      },
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    await expect(ports.request(planned)).rejects.toThrow("refused before dispatch");
    expect(calls).toBe(0);
    expect(usage).toBe(0);
  });

  it("seals reviewed input and sandbox policy and spends the create permit once", async () => {
    let calls = 0;
    let usage = 0;
    let remote = "";
    const ports = makeProviderCloudPorts({
      intent,
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000001"),
      credentialResolver: {
        has: async () => true,
        resolve: async () => "synthetic-not-an-account-key",
      },
      admission: () => true,
      onCreateDispatch: () => {
        usage += 1;
      },
      onCreated: (id) => {
        remote = id;
      },
      fetch: async () => {
        calls += 1;
        return Response.json({ id: "sess_owned", status: "in_progress" });
      },
    });
    for (const mutate of [
      (body: Record<string, unknown>) => ({ ...body, input: "unreviewed input" }),
      (body: Record<string, unknown>) => ({
        ...body,
        environment: { network: { access: "enabled" } },
      }),
      (body: Record<string, unknown>) => ({
        ...body,
        agent: { model: "different-model", tools: [{ type: "function" }] },
      }),
      (body: Record<string, unknown>) => ({
        ...body,
        environment: { files: [{ path: "/secret", content: "unreviewed" }] },
      }),
    ])
      await expect(
        ports.request({
          ...planned,
          body: JSON.stringify(mutate(JSON.parse(planned.body ?? "{}"))),
        }),
      ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(usage).toBe(0);
    await ports.request(planned);
    expect(calls).toBe(1);
    expect(usage).toBe(1);
    expect(remote).toBe("sess_owned");
    await expect(ports.request(planned)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(usage).toBe(1);
    const read = makeProviderCloudPorts({
      intent: { kind: "read", remoteId: decodeProviderCloudRemoteId("sess_owned") },
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000001"),
      credentialResolver: {
        has: async () => true,
        resolve: async () => "synthetic-not-an-account-key",
      },
      admission: () => true,
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    await expect(
      read.request({ method: "GET", path: "/v1/agents/sessions/sess_someone_else" }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(usage).toBe(1);
  });

  it("rechecks local admission after credential unlock and never sends a revoked request", async () => {
    let current = true;
    let resume: ((value: string) => void) | undefined;
    const credential = new Promise<string>((resolve) => {
      resume = resolve;
    });
    let calls = 0;
    const ports = makeProviderCloudPorts({
      instanceId: decodeProviderInstanceId("a7550000-0000-4000-8000-000000000001"),
      credentialResolver: { has: async () => true, resolve: () => credential },
      admission: () => current,
      intent,
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    const pending = ports.request(planned);
    current = false;
    resume?.("synthetic-not-an-account-key");
    await expect(pending).rejects.toThrow("refused before dispatch");
    expect(calls).toBe(0);
    await expect(
      ports.request({ method: "GET", path: "//unrelated.invalid/path" }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
