import { describe, expect, it } from "vitest";
import type { ImageGenerationCustomSource, ImageJob, ProviderInstance } from "@octant/contracts";
import {
  ImageJobPolicyRejected,
  assertCustomImageSourceEligible,
  assertImageJobProfileEligible,
  assertImageJobTransitionAllowed,
  isImageJobTerminalStatus,
} from "./imageJobPolicy";

const timestamp = "2026-08-28T12:00:00.000Z";

function imageProfile(enabled = true): ProviderInstance {
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
    },
  };
}

describe("image job transitions", () => {
  it("allows the AgentRun lifecycle subset queued → running → completed", () => {
    assertImageJobTransitionAllowed("queued", "running");
    assertImageJobTransitionAllowed("running", "completed");
    assertImageJobTransitionAllowed("running", "failed");
    assertImageJobTransitionAllowed("running", "cancelled");
    assertImageJobTransitionAllowed("queued", "cancelled");
  });

  it("refuses a completed job that never ran", () => {
    expect(() => assertImageJobTransitionAllowed("queued", "completed")).toThrow(
      ImageJobPolicyRejected,
    );
  });

  it("treats completed, failed, and cancelled as terminal", () => {
    expect(isImageJobTerminalStatus("completed")).toBe(true);
    expect(isImageJobTerminalStatus("failed")).toBe(true);
    expect(isImageJobTerminalStatus("cancelled")).toBe(true);
    expect(isImageJobTerminalStatus("running")).toBe(false);
    expect(isImageJobTerminalStatus("queued")).toBe(false);
  });
});

describe("image job profile eligibility", () => {
  it("accepts an enabled image profile whose allowlist contains the model", () => {
    assertImageJobProfileEligible(imageProfile(), "gpt-image-2" as ImageJob["modelId"]);
  });

  it("refuses a disabled image profile", () => {
    expect(() =>
      assertImageJobProfileEligible(imageProfile(false), "gpt-image-2" as ImageJob["modelId"]),
    ).toThrow(ImageJobPolicyRejected);
  });

  it("refuses a model outside the profile allowlist", () => {
    expect(() =>
      assertImageJobProfileEligible(imageProfile(), "dall-e-3" as ImageJob["modelId"]),
    ).toThrow(ImageJobPolicyRejected);
  });

  it("refuses a chat provider used as an image profile", () => {
    const chat: ProviderInstance = {
      ...imageProfile(),
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://api.openai.com/v1",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: ["gpt-4o" as never],
      },
    };
    expect(() => assertImageJobProfileEligible(chat, "gpt-image-2" as ImageJob["modelId"])).toThrow(
      ImageJobPolicyRejected,
    );
  });
});

function compatibleInstance(enabled = true): ProviderInstance {
  return {
    id: "a1000000-0000-4000-8000-000000000006" as ProviderInstance["id"],
    displayName: "Recraft",
    enabled,
    environmentPolicy: "inherit-host",
    version: 1 as ProviderInstance["version"],
    createdAt: timestamp as ProviderInstance["createdAt"],
    updatedAt: timestamp as ProviderInstance["updatedAt"],
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.recraft.ai/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
  };
}

describe("custom image source eligibility", () => {
  it("accepts an enabled compatible instance registered as a custom source", () => {
    const instance = compatibleInstance();
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: instance.id, modelId: "recraftv3" as never, label: "Recraft" },
    ];
    assertCustomImageSourceEligible(instance, "recraftv3" as ImageJob["modelId"], customSources);
  });

  it("refuses a disabled compatible instance", () => {
    const instance = compatibleInstance(false);
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: instance.id, modelId: "recraftv3" as never, label: "Recraft" },
    ];
    expect(() =>
      assertCustomImageSourceEligible(instance, "recraftv3" as ImageJob["modelId"], customSources),
    ).toThrow(ImageJobPolicyRejected);
  });

  it("refuses a driver kind that is not openai-compatible", () => {
    const instance = imageProfile();
    const customSources: ReadonlyArray<ImageGenerationCustomSource> = [
      { providerInstanceId: instance.id, modelId: "gpt-image-2" as never, label: "Not compatible" },
    ];
    expect(() =>
      assertCustomImageSourceEligible(
        instance,
        "gpt-image-2" as ImageJob["modelId"],
        customSources,
      ),
    ).toThrow(ImageJobPolicyRejected);
  });

  it("refuses a provider and model pair that was never registered", () => {
    const instance = compatibleInstance();
    expect(() =>
      assertCustomImageSourceEligible(instance, "recraftv3" as ImageJob["modelId"], []),
    ).toThrow(ImageJobPolicyRejected);
  });
});
