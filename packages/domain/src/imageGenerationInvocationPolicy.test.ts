import type { ImageJob, ProviderInstance } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  generatedImageExportAttachments,
  hasEligibleImageProfile,
  honoredImageGenerationOptions,
  listEligibleImageProfiles,
} from "./imageGenerationInvocationPolicy";

const timestamp = "2026-08-28T12:00:00.000Z";

function openAiImage(enabled = true): ProviderInstance {
  return {
    id: "a1000000-0000-4000-8000-000000000004" as ProviderInstance["id"],
    displayName: "OpenAI Image",
    enabled,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: timestamp as ProviderInstance["createdAt"],
    updatedAt: timestamp as ProviderInstance["updatedAt"],
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2" as never],
      defaultModel: "gpt-image-2" as never,
      quality: "high",
    },
  };
}

function geminiImage(): ProviderInstance {
  return {
    ...openAiImage(),
    id: "a1000000-0000-4000-8000-000000000005" as ProviderInstance["id"],
    displayName: "Gemini Image",
    driverKind: "gemini-native-image",
    configuration: {
      kind: "gemini-native-image-http",
      modelAllowlist: ["gemini-3.1-flash-image" as never],
      defaultModel: "gemini-3.1-flash-image" as never,
      aspectRatio: "16:9",
    },
  };
}

function chatProvider(): ProviderInstance {
  return {
    ...openAiImage(),
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: ["gpt-4o" as never],
    },
  };
}

describe("eligible image profiles", () => {
  it("lists only enabled image profiles, never a chat driver", () => {
    const profiles = listEligibleImageProfiles([openAiImage(), geminiImage(), chatProvider()]);
    expect(profiles.map((profile) => profile.displayName)).toEqual([
      "OpenAI Image",
      "Gemini Image",
    ]);
    expect(hasEligibleImageProfile([chatProvider(), openAiImage(false)])).toBe(false);
    expect(hasEligibleImageProfile([openAiImage()])).toBe(true);
  });

  it("omits a disabled image profile", () => {
    expect(listEligibleImageProfiles([openAiImage(false)])).toEqual([]);
  });
});

describe("generation options a selected model can honor", () => {
  it("shows OpenAI quality and size, not Gemini aspect ratio", () => {
    const options = honoredImageGenerationOptions("openai-image-http");
    expect(options.kind).toBe("openai-image-http");
    if (options.kind !== "openai-image-http") return;
    expect(options.qualities).toContain("high");
    expect(options.sizes).toContain("1024x1024");
    expect(options.maxVariants).toBe(4);
    expect("aspectRatios" in options).toBe(false);
  });

  it("shows Gemini aspect ratio and resolution, not OpenAI quality", () => {
    const options = honoredImageGenerationOptions("gemini-native-image-http");
    expect(options.kind).toBe("gemini-native-image-http");
    if (options.kind !== "gemini-native-image-http") return;
    expect(options.aspectRatios).toContain("16:9");
    expect(options.resolutions).toContain("1K");
    expect("qualities" in options).toBe(false);
  });
});

describe("generated image export attachments", () => {
  it("includes completed artifacts with provenance and omits unfinished jobs", () => {
    const parent = {
      attachmentId:
        "a1000000-0000-4000-8000-000000000010" as ImageJob["artifacts"][number]["attachmentId"],
      hash: "b".repeat(64),
      size: 12,
      mime: "image/png" as const,
    };
    const completed: ImageJob = {
      id: "a1000000-0000-4000-8000-000000000001" as ImageJob["id"],
      status: "completed",
      threadKind: "chat-thread",
      scopeId: "a1000000-0000-4000-8000-000000000003" as ImageJob["scopeId"],
      profileInstanceId: openAiImage().id,
      modelId: "gpt-image-2" as ImageJob["modelId"],
      promptHash: "a".repeat(64),
      parentArtifactRef: parent,
      artifacts: [
        {
          attachmentId:
            "a1000000-0000-4000-8000-000000000002" as ImageJob["artifacts"][number]["attachmentId"],
          hash: "c".repeat(64),
          size: 48,
          mime: "image/png",
          evidence: {
            profileInstanceId: openAiImage().id,
            modelId: "gpt-image-2" as ImageJob["modelId"],
            promptHash: "a".repeat(64),
            jobId: "a1000000-0000-4000-8000-000000000001" as ImageJob["id"],
            parentArtifactRef: parent,
          },
        },
      ],
      version: 3 as ImageJob["version"],
      createdAt: timestamp as ImageJob["createdAt"],
      updatedAt: timestamp as ImageJob["updatedAt"],
    };
    const { parentArtifactRef: _parent, ...runningBase } = completed;
    const running: ImageJob = {
      ...runningBase,
      id: "a1000000-0000-4000-8000-000000000009" as ImageJob["id"],
      status: "running",
      artifacts: [],
      version: 2 as ImageJob["version"],
    };
    const attachments = generatedImageExportAttachments([completed, running]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      displayName: "generated-1.png",
      mediaType: "image/png",
      byteLength: 48,
      status: "finalized",
      generation: {
        jobId: completed.id,
        modelId: "gpt-image-2",
        parentAttachmentId: parent.attachmentId,
      },
    });
  });
});
