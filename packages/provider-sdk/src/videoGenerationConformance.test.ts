import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import { decodeVideoModelCapabilities } from "@octant/contracts/video-generation";
import { describe, expect, it } from "vitest";
import { isProviderFailure } from "./imageGeneration";
import {
  classifyVideoHttpFailure,
  jsonField,
  readVideoJson,
  refuseOutsideDeclaration,
  videoFailure,
  type VideoAdapterPoll,
  type VideoGenerationDriver,
  type VideoHttpRequest,
} from "./videoGeneration";
import {
  CONFORMANCE_MP4_BYTES,
  runVideoGenerationConformance,
  type VideoGenerationConformanceFixture,
} from "./videoGenerationConformance";

const modelId = decodeProviderModelId("clip-model");
const capabilities = decodeVideoModelCapabilities({
  modelId: "clip-model",
  displayName: "Clip Model",
  durations: { kind: "range", min: 2, max: 10 },
  resolutions: ["720p"],
  aspectRatios: [{ ratio: "16:9" }],
  audio: "none",
  inputs: { firstFrame: false, lastFrame: false, maxReferenceImages: 0 },
  price: { kind: "per-second", rates: [{ resolution: "720p", usdMicrosPerSecond: 50_000 }] },
  job: { cancel: "running", removal: { kind: "delete" }, resumeWindowHours: 24 },
});

const asFailure = (error: unknown) =>
  isProviderFailure(error)
    ? error
    : videoFailure("provider-failed", "The provider request failed.");

/** A task-polling provider written only against the seam. */
function taskDriver(options: { readonly checkFirst: boolean }): VideoGenerationDriver {
  return {
    driverKind: "gemini-video",
    providerName: "Example Video",
    providerHosts: ["video.example.test"],
    create: ({ ports }) => ({
      models: async () => [capabilities],
      start: async (request) => {
        if (options.checkFirst) {
          const refusal = refuseOutsideDeclaration([capabilities], request);
          if (refusal !== undefined) return { status: "failed", providerFailure: refusal };
        }
        try {
          const response = await ports.request({
            url: "https://video.example.test/v1/tasks",
            method: "POST",
            auth: { header: "authorization", scheme: "Bearer" },
            body: JSON.stringify({ prompt: request.prompt }),
          });
          if (!response.ok) {
            return { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
          }
          const id = jsonField(await readVideoJson(response), "id");
          return typeof id === "string"
            ? { status: "started", remoteId: id }
            : {
                status: "failed",
                providerFailure: videoFailure("protocol", "The provider returned no task id."),
              };
        } catch (error) {
          return { status: "failed", providerFailure: asFailure(error) };
        }
      },
      poll: async (remoteId): Promise<VideoAdapterPoll> => {
        try {
          const response = await ports.request({
            url: `https://video.example.test/v1/tasks/${remoteId}`,
            method: "GET",
            auth: { header: "authorization", scheme: "Bearer" },
          });
          const payload = await readVideoJson(response);
          if (jsonField(payload, "status") !== "SUCCEEDED") return { status: "running" };
          const url = jsonField(payload, "output");
          const fetched = await ports.fetchApprovedVideoUrl({ url: String(url) });
          if ("failure" in fetched) return { status: "failed", providerFailure: fetched.failure };
          if (ports.sniffMediaType(fetched.bytes) !== "video/mp4") {
            return {
              status: "failed",
              providerFailure: videoFailure("protocol", "The provider returned no MP4."),
            };
          }
          return { status: "completed", video: { bytes: fetched.bytes, mediaType: "video/mp4" } };
        } catch (error) {
          return { status: "failed", providerFailure: asFailure(error) };
        }
      },
      cancel: async (remoteId) => {
        await ports.request({
          url: `https://video.example.test/v1/tasks/${remoteId}`,
          method: "DELETE",
          auth: { header: "authorization", scheme: "Bearer" },
        });
        return { status: "cancelled" };
      },
      forget: async (remoteId) => {
        const response = await ports.request({
          url: `https://video.example.test/v1/tasks/${remoteId}`,
          method: "DELETE",
          auth: { header: "authorization", scheme: "Bearer" },
        });
        return response.ok
          ? { status: "removed" }
          : { status: "failed", providerFailure: classifyVideoHttpFailure(response) };
      },
    }),
  };
}

function script(): (request: VideoHttpRequest) => Response {
  let polls = 0;
  return (request) => {
    if (request.method === "POST") return Response.json({ id: "task-1" });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    polls += 1;
    return Response.json(
      polls < 2
        ? { status: "RUNNING" }
        : { status: "SUCCEEDED", output: "https://cdn.example.test/clip.mp4" },
    );
  };
}

const fixture = (driver: VideoGenerationDriver): VideoGenerationConformanceFixture => ({
  driver,
  profile: {
    instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-0000000000b1"),
    modelIds: [modelId],
  },
  request: {
    modelId,
    prompt: "A paper boat on a pond",
    options: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: false },
    references: [],
  },
  respond: script,
  approvedVideoBytes: CONFORMANCE_MP4_BYTES,
});

describe("video generation conformance", () => {
  it("accepts a driver that keeps every promise of the seam", async () => {
    await expect(
      runVideoGenerationConformance(fixture(taskDriver({ checkFirst: true }))),
    ).resolves.toMatchObject({
      outsideDeclarationRefusedBeforeAnyCall: true,
      cancelAndForgetResolve: true,
    });
  });

  it("refuses a driver that calls out before checking its declaration", async () => {
    await expect(
      runVideoGenerationConformance(fixture(taskDriver({ checkFirst: false }))),
    ).rejects.toThrow("a cancelled request did not fail as interrupted");
  });

  it("names a refused option in plain words before anything is sent", () => {
    const refusal = refuseOutsideDeclaration([capabilities], {
      modelId,
      prompt: "A paper boat",
      options: { durationSeconds: 12, resolution: "720p", aspectRatio: "16:9", audio: false },
      references: [],
      signal: new AbortController().signal,
    });
    expect(refusal).toEqual({
      category: "invalid-configuration",
      message: "Clip Model does not make 12-second clips.",
    });
  });

  it("tells a person without video credit what to check", () => {
    expect(classifyVideoHttpFailure(new Response(null, { status: 402 })).category).toBe(
      "unauthorized",
    );
  });
});
