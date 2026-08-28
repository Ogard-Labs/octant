import { describe, expect, it, vi } from "vitest";
import type { ImageJob, ProviderInstance } from "@octant/contracts";
import { createImageAgentTools, IMAGE_TOOL_NAME } from "./imageAgentTools";

const now = "2026-08-28T12:00:00.000Z";
const scopeId = "a3000000-0000-4000-8000-000000000002" as never;
const profileId = "a3000000-0000-4000-8000-000000000001" as ProviderInstance["id"];
const parentAttachmentId = "a3000000-0000-4000-8000-000000000010";

function imageProfile(enabled = true): ProviderInstance {
  return {
    id: profileId,
    displayName: "OpenAI Image",
    enabled,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: now as ProviderInstance["createdAt"],
    updatedAt: now as ProviderInstance["updatedAt"],
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
    },
  };
}

function job(status: ImageJob["status"] = "queued"): ImageJob {
  return {
    id: "a3000000-0000-4000-8000-000000000003" as ImageJob["id"],
    status,
    threadKind: "chat-thread",
    scopeId,
    profileInstanceId: profileId,
    modelId: "gpt-image-2" as ImageJob["modelId"],
    promptHash: "a".repeat(64),
    artifacts:
      status === "completed"
        ? [
            {
              attachmentId: parentAttachmentId as ImageJob["artifacts"][number]["attachmentId"],
              hash: "b".repeat(64),
              size: 12,
              mime: "image/png",
              evidence: {
                profileInstanceId: profileId,
                modelId: "gpt-image-2" as ImageJob["modelId"],
                promptHash: "a".repeat(64),
                jobId: "a3000000-0000-4000-8000-000000000003" as ImageJob["id"],
              },
            },
          ]
        : [],
    version: 1 as ImageJob["version"],
    createdAt: now as ImageJob["createdAt"],
    updatedAt: now as ImageJob["updatedAt"],
  };
}

function tools(instances: ReadonlyArray<ProviderInstance>, jobs: ReadonlyArray<ImageJob> = []) {
  const enqueue = vi.fn(async () => job());
  const set = createImageAgentTools({
    threadKind: "chat-thread",
    scopeId,
    port: {
      listInstances: () => instances,
      enqueue,
      listJobs: () => jobs,
    },
  });
  return { enqueue, set };
}

describe("createImageAgentTools", () => {
  it("is absent when no enabled image profile exists", () => {
    expect(tools([]).set).toBeUndefined();
    expect(tools([imageProfile(false)]).set).toBeUndefined();
  });

  it("offers the tool when an enabled image profile exists", () => {
    const { set } = tools([imageProfile()]);
    expect(set?.definitions.map((definition) => definition.name)).toEqual([IMAGE_TOOL_NAME]);
    expect(set?.definitions[0]?.description).toMatch(/explicitly asked/i);
  });

  it("refuses credentials, endpoints, and filesystem paths", async () => {
    const { set, enqueue } = tools([imageProfile()]);
    const outcome = await set!.execute({
      name: IMAGE_TOOL_NAME,
      inputJson: JSON.stringify({
        prompt: "a red cube",
        apiKey: "sk-secret",
      }),
    });
    expect(outcome.isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("chains an edit to the parent artifact on this thread", async () => {
    const { set, enqueue } = tools([imageProfile()], [job("completed")]);
    const outcome = await set!.execute({
      name: IMAGE_TOOL_NAME,
      inputJson: JSON.stringify({
        prompt: "make the cube blue",
        parentAttachmentId,
      }),
    });
    expect(outcome.isError).toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make the cube blue",
        parentArtifactRef: expect.objectContaining({ attachmentId: parentAttachmentId }),
      }),
    );
  });
});
