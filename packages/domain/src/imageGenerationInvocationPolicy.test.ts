import type { ImageGenerationCustomSource, ImageJob, ProviderInstance } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  generatedImageExportAttachments,
  hasEligibleImageProfile,
  honoredImageGenerationOptions,
  imageGenerationConfigurationKind,
  listCustomImageProfiles,
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

function bflImage(): ProviderInstance {
  return {
    ...openAiImage(),
    id: "a1000000-0000-4000-8000-000000000008" as ProviderInstance["id"],
    displayName: "FLUX",
    driverKind: "bfl-image",
    configuration: {
      kind: "bfl-image-http",
      modelAllowlist: ["flux-pro-1.1" as never],
      defaultModel: "flux-pro-1.1" as never,
    },
  };
}

function chatProvider(enabled = true): ProviderInstance {
  return {
    ...openAiImage(enabled),
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

function recraft(enabled = true): ProviderInstance {
  return { ...chatProvider(enabled), id: "a1000000-0000-4000-8000-000000000007" as never };
}

describe("eligible image profiles", () => {
  it("lists only enabled image profiles, never a chat driver", () => {
    const profiles = listEligibleImageProfiles([
      openAiImage(),
      geminiImage(),
      bflImage(),
      chatProvider(),
    ]);
    expect(profiles.map((profile) => profile.displayName)).toEqual([
      "OpenAI Image",
      "Gemini Image",
      "FLUX",
    ]);
    expect(hasEligibleImageProfile([chatProvider(), openAiImage(false)])).toBe(false);
    expect(hasEligibleImageProfile([openAiImage()])).toBe(true);
  });

  it("lists a BFL image profile with no quality, size, or aspect ratio fields", () => {
    const profiles = listEligibleImageProfiles([bflImage()]);
    expect(profiles).toEqual([
      {
        instanceId: bflImage().id,
        displayName: "FLUX",
        driverKind: "bfl-image",
        modelAllowlist: ["flux-pro-1.1"],
        defaultModel: "flux-pro-1.1",
      },
    ]);
  });

  it("omits a disabled image profile", () => {
    expect(listEligibleImageProfiles([openAiImage(false)])).toEqual([]);
  });

  it("appends ready custom sources after the fixed-kind profiles", () => {
    const instance = recraft();
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: instance.id, modelId: "recraftv3" as never, label: "Recraft" },
    ];
    const profiles = listEligibleImageProfiles([openAiImage(), instance], customSources);
    expect(profiles.map((profile) => profile.displayName)).toEqual(["OpenAI Image", "Recraft"]);
    expect(profiles[1]).toMatchObject({
      driverKind: "openai-compatible-image",
      modelAllowlist: ["recraftv3"],
      defaultModel: "recraftv3",
    });
    expect(hasEligibleImageProfile([instance], customSources)).toBe(true);
    expect(hasEligibleImageProfile([instance])).toBe(false);
  });
});

describe("custom image profiles", () => {
  it("lists a ready custom source and omits an unavailable one", () => {
    const ready = recraft();
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: ready.id, modelId: "recraftv3" as never, label: "Recraft" },
      {
        providerInstanceId: "a1000000-0000-4000-8000-000000000fff" as never,
        modelId: "gone" as never,
        label: "Removed",
      },
    ];
    const profiles = listCustomImageProfiles(customSources, [ready]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      instanceId: ready.id,
      displayName: "Recraft",
      driverKind: "openai-compatible-image",
      modelAllowlist: ["recraftv3"],
      defaultModel: "recraftv3",
    });
  });

  it("omits a custom source whose instance is disabled", () => {
    const disabled = recraft(false);
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: disabled.id, modelId: "recraftv3" as never, label: "Recraft" },
    ];
    expect(listCustomImageProfiles(customSources, [disabled])).toEqual([]);
  });

  it("folds two models on the same instance into one profile, never two profiles at one instanceId", () => {
    const instance = recraft();
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: instance.id, modelId: "recraftv3" as never, label: "Recraft square" },
      {
        providerInstanceId: instance.id,
        modelId: "recraftv3-vector" as never,
        label: "Recraft vector",
      },
    ];
    const profiles = listCustomImageProfiles(customSources, [instance]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      instanceId: instance.id,
      displayName: "Recraft square, Recraft vector",
      driverKind: "openai-compatible-image",
      modelAllowlist: ["recraftv3", "recraftv3-vector"],
      defaultModel: "recraftv3",
    });
  });

  it("bounds a combined displayName to the profile contract's 120-character limit", () => {
    const instance = recraft();
    const label = "a".repeat(120);
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: instance.id, modelId: "recraftv3" as never, label },
      { providerInstanceId: instance.id, modelId: "recraftv3-vector" as never, label },
    ];
    const profiles = listCustomImageProfiles(customSources, [instance]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.displayName.length).toBeLessThanOrEqual(120);
    expect(profiles[0]?.displayName.endsWith("…")).toBe(true);
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

  it("shows neither quality nor aspect ratio for a custom source", () => {
    const options = honoredImageGenerationOptions("openai-compatible-http");
    expect(options).toEqual({
      kind: "openai-compatible-http",
      maxVariants: 4,
      supportsReferences: true,
    });
  });

  it("caps BFL at one variant and no reference support, a real provider constraint", () => {
    const options = honoredImageGenerationOptions("bfl-image-http");
    expect(options).toEqual({
      kind: "bfl-image-http",
      maxVariants: 1,
      supportsReferences: false,
    });
  });
});

describe("image generation configuration kind", () => {
  it("maps every driver kind to its configuration kind exhaustively", () => {
    expect(imageGenerationConfigurationKind("openai-image")).toBe("openai-image-http");
    expect(imageGenerationConfigurationKind("gemini-native-image")).toBe(
      "gemini-native-image-http",
    );
    expect(imageGenerationConfigurationKind("openai-compatible-image")).toBe(
      "openai-compatible-http",
    );
    expect(imageGenerationConfigurationKind("bfl-image")).toBe("bfl-image-http");
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
      displayName: `generated-${String(completed.id)}-1.png`,
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

  it("names exported images from media type and job identity", () => {
    const jpegJob: ImageJob = {
      id: "a1000000-0000-4000-8000-000000000021" as ImageJob["id"],
      status: "completed",
      threadKind: "chat-thread",
      scopeId: "a1000000-0000-4000-8000-000000000003" as ImageJob["scopeId"],
      profileInstanceId: openAiImage().id,
      modelId: "gpt-image-2" as ImageJob["modelId"],
      promptHash: "a".repeat(64),
      artifacts: [
        {
          attachmentId:
            "a1000000-0000-4000-8000-000000000022" as ImageJob["artifacts"][number]["attachmentId"],
          hash: "c".repeat(64),
          size: 48,
          mime: "image/jpeg",
          evidence: {
            profileInstanceId: openAiImage().id,
            modelId: "gpt-image-2" as ImageJob["modelId"],
            promptHash: "a".repeat(64),
            jobId: "a1000000-0000-4000-8000-000000000021" as ImageJob["id"],
          },
        },
      ],
      version: 3 as ImageJob["version"],
      createdAt: timestamp as ImageJob["createdAt"],
      updatedAt: timestamp as ImageJob["updatedAt"],
    };
    expect(generatedImageExportAttachments([jpegJob])[0]?.displayName).toBe(
      `generated-${String(jpegJob.id)}-1.jpg`,
    );
  });
});
