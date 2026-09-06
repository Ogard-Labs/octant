import { describe, expect, it } from "vitest";
import {
  IMAGE_GENERATION_REQUEST_SHAPE,
  IMAGE_JOB_AGGREGATE_TYPE,
  IMAGE_JOB_EVENT_NAMES,
  IMAGE_JOB_QUEUED,
  IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
  IMAGE_JOB_STATUS_CHANGED,
  decodeImageArtifactId,
  decodeImageGenerationEnqueueRequest,
  decodeImageGenerationEvidence,
  decodeImageGenerationProfileView,
  decodeImageGenerationScopeId,
  decodeImageJob,
  decodeImageJobId,
  decodeImageJobQueued,
  decodeImageJobStatusChanged,
  decodeImageUsageUnits,
} from "./imageGeneration";

const ids = {
  job: "a1000000-0000-4000-8000-000000000001",
  artifact: "a1000000-0000-4000-8000-000000000002",
  scope: "a1000000-0000-4000-8000-000000000003",
  profile: "a1000000-0000-4000-8000-000000000004",
} as const;
const timestamp = "2026-08-28T12:00:00.000Z";
const promptHash = "a".repeat(64);
const artifactHash = "b".repeat(64);

const queuedJob = {
  id: ids.job,
  status: "queued",
  threadKind: "chat-thread",
  scopeId: ids.scope,
  profileInstanceId: ids.profile,
  modelId: "gpt-image-2",
  promptHash,
  artifacts: [],
  version: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;

describe("image generation identities", () => {
  it("accepts branded UUIDs and rejects path-like values", () => {
    expect(decodeImageJobId(ids.job)).toBe(ids.job);
    expect(decodeImageArtifactId(ids.artifact)).toBe(ids.artifact);
    expect(decodeImageGenerationScopeId(ids.scope)).toBe(ids.scope);
    expect(() => decodeImageJobId("../escape")).toThrow();
    expect(() => decodeImageArtifactId("not-a-uuid")).toThrow();
    expect(() => decodeImageGenerationScopeId("generated-images/../etc")).toThrow();
  });
});

describe("ImageJob", () => {
  it("decodes a queued job without artifacts or provider payloads", () => {
    const job = decodeImageJob(queuedJob);
    expect(job.status).toBe("queued");
    expect(job.artifacts).toEqual([]);
    expect(JSON.stringify(job)).not.toContain("b64");
    expect(JSON.stringify(job)).not.toContain("http");
  });

  it("records completed artifacts as refs, hashes, and generation evidence", () => {
    const job = decodeImageJob({
      ...queuedJob,
      status: "completed",
      version: 3,
      artifacts: [
        {
          attachmentId: ids.artifact,
          hash: artifactHash,
          size: 128,
          mime: "image/png",
          evidence: {
            profileInstanceId: ids.profile,
            modelId: "gpt-image-2",
            promptHash,
            jobId: ids.job,
          },
        },
      ],
    });
    expect(job.artifacts[0]?.hash).toBe(artifactHash);
    expect(JSON.stringify(job)).not.toContain("b64_json");
    expect(JSON.stringify(job)).not.toContain("data:image");
    expect(JSON.stringify(job)).not.toContain("https://");
  });

  it("rejects a completed job that still has no artifacts", () => {
    expect(() => decodeImageJob({ ...queuedJob, status: "completed", version: 3 })).toThrow();
  });

  it("rejects a failed job that kept partial artifacts", () => {
    expect(() =>
      decodeImageJob({
        ...queuedJob,
        status: "failed",
        version: 3,
        failure: { category: "provider-failed", message: "The provider request failed." },
        artifacts: [
          {
            attachmentId: ids.artifact,
            hash: artifactHash,
            size: 128,
            mime: "image/png",
            evidence: {
              profileInstanceId: ids.profile,
              modelId: "gpt-image-2",
              promptHash,
              jobId: ids.job,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects evidence that carries a provider URL", () => {
    expect(() =>
      decodeImageGenerationEvidence({
        profileInstanceId: ids.profile,
        modelId: "gpt-image-2",
        promptHash,
        jobId: ids.job,
        url: "https://cdn.openai.com/generated.png",
      }),
    ).toThrow();
  });
});

describe("image job events", () => {
  it("publishes the versioned job vocabulary", () => {
    expect(IMAGE_JOB_AGGREGATE_TYPE).toBe("image-job");
    expect(IMAGE_JOB_EVENT_NAMES).toEqual([IMAGE_JOB_QUEUED, IMAGE_JOB_STATUS_CHANGED]);
    expect(IMAGE_GENERATION_REQUEST_SHAPE).toBe("image-generation");
    expect(IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE).toBe("interrupted by restart");
  });

  it("decodes queued and status-changed envelopes", () => {
    expect(decodeImageJobQueued({ job: queuedJob }).job.id).toBe(ids.job);
    const changed = decodeImageJobStatusChanged({
      jobId: ids.job,
      fromStatus: "running",
      toStatus: "failed",
      version: 3,
      updatedAt: timestamp,
      recoveryReason: IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
      failure: {
        category: "interrupted",
        message: IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE,
      },
    });
    expect(changed.recoveryReason).toBe("interrupted by restart");
  });

  it("rejects status-changed payloads that include image bytes", () => {
    expect(() =>
      decodeImageJobStatusChanged({
        jobId: ids.job,
        fromStatus: "running",
        toStatus: "completed",
        version: 3,
        updatedAt: timestamp,
        b64_json: "aaaa",
      }),
    ).toThrow();
  });
});

describe("ImageUsageUnits", () => {
  it("decodes image count, size, and output quality without a schema-version bump", () => {
    expect(
      decodeImageUsageUnits({
        count: 1,
        quality: "exact",
        size: "1024x1024",
        outputQuality: "high",
      }),
    ).toEqual({
      count: 1,
      quality: "exact",
      size: "1024x1024",
      outputQuality: "high",
    });
  });

  it("rejects a zero image count", () => {
    expect(() => decodeImageUsageUnits({ count: 0, quality: "exact" })).toThrow();
  });
});

describe("ImageGenerationProfileView", () => {
  it("decodes a BFL profile view with no quality, size, aspect ratio, or resolution", () => {
    const view = decodeImageGenerationProfileView({
      instanceId: ids.profile,
      displayName: "FLUX",
      driverKind: "bfl-image",
      modelAllowlist: ["flux-pro-1.1"],
      defaultModel: "flux-pro-1.1",
    });
    expect(view.driverKind).toBe("bfl-image");
    expect(view.quality).toBeUndefined();
    expect(view.size).toBeUndefined();
    expect(view.aspectRatio).toBeUndefined();
    expect(view.resolution).toBeUndefined();
  });

  it("rejects an empty model allowlist regardless of driver kind", () => {
    expect(() =>
      decodeImageGenerationProfileView({
        instanceId: ids.profile,
        displayName: "FLUX",
        driverKind: "bfl-image",
        modelAllowlist: [],
        defaultModel: "flux-pro-1.1",
      }),
    ).toThrow();
  });
});

describe("image generation invocation requests", () => {
  it("accepts an enqueue request without image bytes in the prompt fields", () => {
    expect(
      decodeImageGenerationEnqueueRequest({
        threadKind: "chat-thread",
        scopeId: ids.scope,
        profileInstanceId: ids.profile,
        modelId: "gpt-image-2",
        prompt: "a red cube",
        variantCount: 2,
        quality: "high",
      }),
    ).toMatchObject({ prompt: "a red cube", variantCount: 2, quality: "high" });
  });

  it("rejects an enqueue request that names a filesystem path", () => {
    expect(() =>
      decodeImageGenerationEnqueueRequest({
        threadKind: "chat-thread",
        scopeId: "../escape",
        profileInstanceId: ids.profile,
        modelId: "gpt-image-2",
        prompt: "a red cube",
      }),
    ).toThrow();
  });
});
