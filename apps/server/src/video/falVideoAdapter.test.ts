import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import type { VideoGenerationPorts, VideoHttpRequest } from "@octant/provider-sdk/video-generation";
import {
  CONFORMANCE_MP4_BYTES,
  looksLikeMp4,
  runVideoGenerationConformance,
} from "@octant/provider-sdk/video-generation-conformance";
import { describe, expect, it } from "vitest";
import { falPrice, falVideoDriver } from "./falVideoAdapter";

const veo = decodeProviderModelId("fal-ai/veo3.1");
const veoImage = decodeProviderModelId("fal-ai/veo3.1/image-to-video");
const requestId = "2b1f1e0a-7c55-4e3b-9a3b-0c3f6d1b2a10";
const profile = {
  instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-0000000000e1"),
  modelIds: [veo, veoImage],
};
const options = { durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", audio: true };

/** fal's published queue schema for an endpoint, trimmed to the input it declares (2026-11-22). */
function schema(endpointId: string, imageToVideo: boolean) {
  return {
    paths: {
      [`/${endpointId}`]: {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Input" } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Input: {
          required: imageToVideo ? ["prompt", "image_url"] : ["prompt"],
          properties: {
            prompt: { type: "string" },
            duration: { type: "string", enum: ["4s", "6s", "8s"], default: "8s" },
            generate_audio: { type: "boolean", default: true },
            resolution: { type: "string", enum: ["720p", "1080p", "4k"], default: "720p" },
            aspect_ratio: imageToVideo
              ? { type: "string", enum: ["auto", "16:9", "9:16"], default: "auto" }
              : { type: "string", enum: ["16:9", "9:16"], default: "16:9" },
            ...(imageToVideo ? { image_url: { type: "string" } } : {}),
          },
        },
      },
    },
  };
}

function script(): (request: VideoHttpRequest) => Response {
  let polls = 0;
  return (request) => {
    const url = new URL(request.url);
    if (url.hostname === "fal.ai") {
      const endpoint = url.searchParams.get("endpoint_id") ?? "";
      return Response.json(schema(endpoint, endpoint.endsWith("image-to-video")));
    }
    if (url.hostname === "api.fal.ai") {
      return Response.json({
        prices: [
          { endpoint_id: "fal-ai/veo3.1", unit_price: 0.4, unit: "second", currency: "USD" },
        ],
        next_cursor: null,
        has_more: false,
      });
    }
    if (request.method === "POST") return Response.json({ request_id: requestId });
    if (request.method === "PUT") return Response.json({ status: "OK" }, { status: 200 });
    if (url.pathname.endsWith("/status")) {
      polls += 1;
      return Response.json(
        { status: polls < 2 ? "IN_PROGRESS" : "COMPLETED" },
        { status: polls < 2 ? 202 : 200 },
      );
    }
    return Response.json(
      { video: { url: "https://v3b.fal.media/files/clip.mp4" } },
      { headers: { "x-fal-billable-units": "8" } },
    );
  };
}

function ports(respond: (request: VideoHttpRequest) => Response): {
  readonly ports: VideoGenerationPorts;
  readonly sent: Array<VideoHttpRequest>;
} {
  const sent: Array<VideoHttpRequest> = [];
  return {
    sent,
    ports: {
      request: async (request) => {
        sent.push(request);
        return respond(request);
      },
      fetchApprovedVideoUrl: async () => ({ bytes: CONFORMANCE_MP4_BYTES }),
      sniffMediaType: (bytes) => (looksLikeMp4(bytes) ? "video/mp4" : undefined),
    },
  };
}

describe("fal video driver", () => {
  it("keeps every promise of the video seam", async () => {
    await expect(
      runVideoGenerationConformance({
        driver: falVideoDriver,
        profile,
        request: { modelId: veo, prompt: "A paper boat on a pond", options, references: [] },
        respond: script,
      }),
    ).resolves.toMatchObject({ cancelAndForgetResolve: true });
  });

  it("offers each endpoint what its published schema declares, at fal's price", async () => {
    const adapter = falVideoDriver.create({ profile, ports: ports(script()).ports });
    const [text, image] = await adapter.models();
    expect(text).toMatchObject({
      modelId: "fal-ai/veo3.1",
      durations: { kind: "values", values: [4, 6, 8] },
      defaultDuration: 8,
      resolutions: ["720p", "1080p", "4k"],
      aspectRatios: [{ ratio: "16:9" }, { ratio: "9:16" }],
      audio: "optional",
      inputs: { firstFrame: false },
      // One unit price cannot cover three resolutions and an audio choice.
      price: { kind: "unpublished" },
      job: { cancel: "running", removal: { kind: "expires", afterHours: 2 }, resumeWindowHours: 1 },
    });
    // An image-to-video endpoint needs its frame; fal lists no price for it here.
    expect(image).toMatchObject({
      inputs: { firstFrame: true },
      aspectRatios: [
        { ratio: "16:9", needsImage: true },
        { ratio: "9:16", needsImage: true },
      ],
      price: { kind: "unpublished" },
    });
  });

  it("asks fal to keep no request history and to expire its copy, in the endpoint's own fields", async () => {
    const recorder = ports(script());
    const adapter = falVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId: veo,
      prompt: "A boat",
      options,
      references: [],
      signal: new AbortController().signal,
    });
    expect(started).toEqual({ status: "started", remoteId: `fal-ai/veo3.1#${requestId}` });
    const submit = recorder.sent.find((request) => request.method === "POST");
    expect(submit?.url).toBe("https://queue.fal.run/fal-ai/veo3.1");
    expect(submit?.auth).toEqual({ header: "authorization", scheme: "Key" });
    expect(submit?.headers).toMatchObject({
      "x-fal-store-io": "0",
      "x-fal-object-lifecycle-preference": '{"expiration_duration_seconds":7200}',
    });
    expect(JSON.parse(submit?.body ?? "{}")).toEqual({
      prompt: "A boat",
      duration: "8s",
      resolution: "720p",
      aspect_ratio: "16:9",
      generate_audio: true,
    });
  });

  it("reads per-second and per-video prices, and calls any other unit unpublished", () => {
    const defaults = {
      durationSeconds: 5,
      resolutions: ["720p", "1080p"],
      defaultResolution: "720p",
      audioSelectable: false,
    };
    // One unit price cannot cover billing that varies with resolution or audio.
    expect(falPrice({ unit_price: 0.1, unit: "second", currency: "USD" }, defaults)).toEqual({
      kind: "unpublished",
    });
    expect(
      falPrice(
        { unit_price: 0.1, unit: "second", currency: "USD" },
        { ...defaults, resolutions: ["720p"] },
      ),
    ).toEqual({
      kind: "per-second",
      rates: [{ resolution: "720p", usdMicrosPerSecond: 100_000 }],
    });
    expect(
      falPrice(
        { unit_price: 0.1, unit: "second", currency: "USD" },
        { ...defaults, resolutions: ["720p"], audioSelectable: true },
      ),
    ).toEqual({ kind: "unpublished" });
    expect(falPrice({ unit_price: 0.5, unit: "video", currency: "USD" }, defaults)).toEqual({
      kind: "per-clip",
      rates: [{ durationSeconds: 5, resolution: "720p", usdMicros: 500_000 }],
    });
    expect(falPrice({ unit_price: 0.001, unit: "gpu-second", currency: "USD" }, defaults)).toEqual({
      kind: "unpublished",
    });
    expect(falPrice({ unit_price: 0.1, unit: "second", currency: "EUR" }, defaults)).toEqual({
      kind: "unpublished",
    });
  });

  it("keeps polling when fal has only signalled a running request to stop", async () => {
    const adapter = falVideoDriver.create({
      profile,
      ports: ports(() => Response.json({ status: "CANCELLATION_REQUESTED" }, { status: 202 }))
        .ports,
    });
    expect(await adapter.cancel(`fal-ai/veo3.1#${requestId}`)).toEqual({ status: "running" });
  });

  it("never puts an id fal did not shape into a URL path", async () => {
    const recorder = ports(script());
    const adapter = falVideoDriver.create({ profile, ports: recorder.ports });
    expect((await adapter.poll("fal-ai/veo3.1#../../x", new AbortController().signal)).status).toBe(
      "failed",
    );
    expect(recorder.sent).toHaveLength(0);
  });

  it("offers a frame-counted endpoint the whole seconds its fixed frame rate allows", async () => {
    const wan = decodeProviderModelId("fal-ai/wan/v2.2-a14b/text-to-video");
    const respond = (request: VideoHttpRequest) => {
      const url = new URL(request.url);
      if (url.hostname === "fal.ai") {
        return Response.json({
          paths: {
            "/fal-ai/wan/v2.2-a14b/text-to-video": {
              post: {
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Input" } },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              Input: {
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  num_frames: { type: "integer", minimum: 17, maximum: 161, default: 81 },
                  frames_per_second: { default: 16 },
                  resolution: {
                    type: "string",
                    enum: ["480p", "580p", "720p"],
                    default: "720p",
                  },
                  aspect_ratio: {
                    type: "string",
                    enum: ["16:9", "9:16", "1:1"],
                    default: "16:9",
                  },
                },
              },
            },
          },
        });
      }
      if (url.hostname === "api.fal.ai") return Response.json({ prices: [] });
      if (request.method === "POST") return Response.json({ request_id: requestId });
      return new Response(null, { status: 500 });
    };
    const recorder = ports(respond);
    const adapter = falVideoDriver.create({
      profile: { ...profile, modelIds: [wan] },
      ports: recorder.ports,
    });
    const [model] = await adapter.models();
    expect(model).toMatchObject({
      modelId: "fal-ai/wan/v2.2-a14b/text-to-video",
      durations: { kind: "range", min: 2, max: 10 },
      defaultDuration: 2,
    });
    const started = await adapter.start({
      modelId: wan,
      prompt: "A boat",
      options: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: false },
      references: [],
      signal: new AbortController().signal,
    });
    expect(started.status).toBe("started");
    const submit = recorder.sent.find((request) => request.method === "POST");
    expect(JSON.parse(submit?.body ?? "{}")).toMatchObject({
      num_frames: 80,
      frames_per_second: 16,
    });
    expect(submit?.body).not.toContain('"duration"');
  });

  it("offers a first-and-last-frame endpoint only for what it can fill, and fills it", async () => {
    const frames = decodeProviderModelId("fal-ai/veo3.1/first-last-frame-to-video");
    const respond = (request: VideoHttpRequest) => {
      const url = new URL(request.url);
      if (url.hostname === "fal.ai") {
        return Response.json({
          paths: {
            "/fal-ai/veo3.1/first-last-frame-to-video": {
              post: {
                requestBody: {
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Input" } },
                  },
                },
              },
            },
          },
          components: {
            schemas: {
              Input: {
                required: ["prompt", "first_frame_url", "last_frame_url"],
                properties: {
                  prompt: { type: "string" },
                  duration: { type: "string", enum: ["8s"], default: "8s" },
                  aspect_ratio: { type: "string", enum: ["auto", "16:9"], default: "auto" },
                  first_frame_url: { type: "string" },
                  last_frame_url: { type: "string" },
                },
              },
            },
          },
        });
      }
      if (url.hostname === "api.fal.ai") return Response.json({ prices: [] });
      if (request.method === "POST") return Response.json({ request_id: requestId });
      return new Response(null, { status: 500 });
    };
    const recorder = ports(respond);
    const adapter = falVideoDriver.create({
      profile: { ...profile, modelIds: [frames] },
      ports: recorder.ports,
    });
    const [model] = await adapter.models();
    expect(model?.inputs).toEqual({ firstFrame: true, lastFrame: true, maxReferenceImages: 0 });
    expect(model?.aspectRatios.every((ratio) => ratio.needsImage === true)).toBe(true);

    const frame = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" as const };
    const frameOptions = {
      durationSeconds: 8,
      resolution: "model default",
      aspectRatio: "16:9",
      audio: false,
    };
    const without = await adapter.start({
      modelId: frames,
      prompt: "A boat",
      options: frameOptions,
      references: [],
      signal: new AbortController().signal,
    });
    expect(without.status).toBe("failed");
    expect(recorder.sent.every((request) => request.method !== "POST")).toBe(true);

    const started = await adapter.start({
      modelId: frames,
      prompt: "A boat",
      options: frameOptions,
      firstFrame: frame,
      lastFrame: frame,
      references: [],
      signal: new AbortController().signal,
    });
    expect(started.status).toBe("started");
    const submit = recorder.sent.find((request) => request.method === "POST");
    expect(JSON.parse(submit?.body ?? "{}")).toMatchObject({
      first_frame_url: "data:image/png;base64,AQID",
      last_frame_url: "data:image/png;base64,AQID",
    });
  });

  it("reads the endpoint schemas again after a discovery that failed", async () => {
    let attempts = 0;
    const adapter = falVideoDriver.create({
      profile,
      ports: ports((request) => {
        const url = new URL(request.url);
        if (url.hostname === "fal.ai") {
          attempts += 1;
          if (attempts === 1) return new Response(null, { status: 503 });
          const endpoint = url.searchParams.get("endpoint_id") ?? "";
          return Response.json(schema(endpoint, endpoint.endsWith("image-to-video")));
        }
        if (url.hostname === "api.fal.ai") return Response.json({ prices: [] });
        return new Response(null, { status: 500 });
      }).ports,
    });
    await expect(adapter.models()).rejects.toMatchObject({ category: "unavailable" });
    const models = await adapter.models();
    expect(models.map((model) => model.modelId)).toEqual([
      "fal-ai/veo3.1",
      "fal-ai/veo3.1/image-to-video",
    ]);
  });

  it("says why a profile offers nothing when no endpoint can be described", async () => {
    const still = decodeProviderModelId("fal-ai/minimax/video-01-live/image-to-video");
    const adapter = falVideoDriver.create({
      profile: { ...profile, modelIds: [still] },
      ports: ports((request) => {
        const url = new URL(request.url);
        if (url.hostname === "fal.ai") {
          return Response.json({
            paths: {
              "/fal-ai/minimax/video-01-live/image-to-video": {
                post: {
                  requestBody: {
                    content: {
                      "application/json": { schema: { $ref: "#/components/schemas/Input" } },
                    },
                  },
                },
              },
            },
            components: {
              schemas: {
                Input: {
                  required: ["prompt"],
                  properties: {
                    prompt: { type: "string" },
                    prompt_optimizer: { type: "boolean", default: true },
                  },
                },
              },
            },
          });
        }
        if (url.hostname === "api.fal.ai") return Response.json({ prices: [] });
        return new Response(null, { status: 500 });
      }).ports,
    });
    await expect(adapter.models()).rejects.toMatchObject({
      category: "invalid-configuration",
      message: expect.stringContaining("declares no clip length"),
    });
  });

  it("refuses a clip address outside fal's media hosts without fetching it", async () => {
    let fetched = 0;
    const recorder = ports((request) => {
      if (request.method === "POST") return Response.json({ request_id: requestId });
      const url = new URL(request.url);
      if (url.pathname.endsWith("/status")) return Response.json({ status: "COMPLETED" });
      return Response.json({ video: { url: "http://169.254.169.254/latest/meta-data" } });
    });
    const adapter = falVideoDriver.create({ profile, ports: {
      ...recorder.ports,
      fetchApprovedVideoUrl: async () => {
        fetched += 1;
        return { bytes: CONFORMANCE_MP4_BYTES };
      },
    } });
    const polled = await adapter.poll(
      `fal-ai/veo3.1#${requestId}`,
      new AbortController().signal,
    );
    expect(polled.status).toBe("failed");
    expect(fetched).toBe(0);
  });

  it("keeps to the imports a third-party video plugin could make", () => {
    const source = readFileSync(join(import.meta.dirname, "falVideoAdapter.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"|\brequire\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(["@octant/contracts", "@octant/provider-sdk/video-generation"]).toContain(specifier);
    }
  });
});
