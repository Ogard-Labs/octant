import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import type { VideoGenerationPorts, VideoHttpRequest } from "@octant/provider-sdk/video-generation";
import {
  CONFORMANCE_MP4_BYTES,
  looksLikeMp4,
  runVideoGenerationConformance,
} from "@octant/provider-sdk/video-generation-conformance";
import { describe, expect, it, vi } from "vitest";
import { falPrice, falVideoDriver } from "./falVideoAdapter";
import { makeVideoGenerationPorts } from "./videoHttp";

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
      if (request.method === "DELETE") return Response.json({ cdn_delete_results: [] });
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
  it("interrupts discovery while a pooled key's rate-limit body is stalled", async () => {
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = vi.fn(() => release.resolve());
    const reportRejected = vi.fn();
    const adapter = falVideoDriver.create({
      profile: { ...profile, modelIds: [veo] },
      ports: makeVideoGenerationPorts({
        instanceId: String(profile.instanceId),
        providerHosts: ["api.fal.ai", "fal.ai"],
        credentialResolver: {
          has: async () => true,
          resolve: async () => "fixture-key",
          lease: async () => ({ credential: "fixture-key", reportRejected }),
        },
        fetch: async (input) => {
          if (new URL(String(input)).hostname === "fal.ai")
            return Response.json(schema(String(veo), false));
          return new Response(
            new ReadableStream(
              {
                pull(stream) {
                  reading.resolve();
                  return release.promise.then(() => {
                    if (cancelled.mock.calls.length === 0) stream.close();
                  });
                },
                cancel: cancelled,
              },
              { highWaterMark: 0 },
            ),
            { status: 429, headers: { "retry-after": "60" } },
          );
        },
      }),
    });
    const settled = vi.fn();
    const pending = adapter.models(controller.signal).then(
      () => settled("answered"),
      () => settled("interrupted"),
    );
    try {
      await reading.promise;
      controller.abort();
      await vi.waitFor(() => expect(settled).toHaveBeenCalledWith("interrupted"));
      await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      expect(reportRejected).toHaveBeenCalledWith({ status: 429, retryAfterSeconds: 60, body: "" });
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("forwards the discovery signal through pricing and a stalled schema request", async () => {
    const control = new AbortController();
    const sent: Array<VideoHttpRequest> = [];
    const schema = Promise.withResolvers<Response>();
    const adapter = falVideoDriver.create({
      profile,
      ports: {
        ...ports(script()).ports,
        request: async (request) => {
          sent.push(request);
          if (new URL(request.url).hostname === "api.fal.ai") return Response.json({ prices: [] });
          request.signal?.addEventListener("abort", () => schema.reject(request.signal?.reason), {
            once: true,
          });
          return schema.promise;
        },
      },
    });
    const pending = adapter.models(control.signal);
    try {
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      expect(sent.map((request) => request.signal)).toEqual([control.signal, control.signal]);
      control.abort();
      await expect(pending).rejects.toBeDefined();
      expect(sent).toHaveLength(2);
    } finally {
      schema.resolve(new Response(null, { status: 503 }));
      await pending.catch(() => undefined);
    }
  });

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

  it("keeps a submitted clip's declaration when pricing discovery failed", async () => {
    const respond = script();
    const recorder = ports((request) => {
      if (new URL(request.url).pathname === "/v1/models/pricing") {
        throw { category: "unavailable", message: "Pricing could not be reached." };
      }
      return respond(request);
    });
    const adapter = falVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId: veo,
      prompt: "A boat",
      options,
      references: [],
      signal: new AbortController().signal,
    });
    expect(started).toEqual({ status: "started", remoteId: `fal-ai/veo3.1#${requestId}` });
    const sentBeforeLookup = recorder.sent.length;
    await expect(adapter.models()).resolves.toContainEqual(
      expect.objectContaining({
        modelId: veo,
        price: { kind: "unpublished" },
        job: {
          cancel: "running",
          removal: { kind: "expires", afterHours: 2 },
          resumeWindowHours: 1,
        },
      }),
    );
    expect(recorder.sent).toHaveLength(sentBeforeLookup);
  });

  it("sends exactly one DELETE for the request's stored payloads when the host asks", async () => {
    const recorder = ports((request) =>
      request.method === "DELETE"
        ? Response.json({
            cdn_delete_results: [{ link: "https://v3b.fal.media/files/clip.mp4", exception: null }],
          })
        : script()(request),
    );
    const adapter = falVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId: veo,
      prompt: "A boat",
      options,
      references: [],
      signal: new AbortController().signal,
    });
    if (started.status !== "started") throw new Error("The request was not sent.");
    expect(await adapter.forget(started.remoteId)).toEqual({ status: "removed" });
    const deletions = recorder.sent.filter((request) => request.method === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.url).toBe(`https://api.fal.ai/v1/models/requests/${requestId}/payloads`);
    expect(deletions[0]?.auth).toEqual({ header: "authorization", scheme: "Key" });
  });

  it.each(["pricing", "schema"] as const)(
    "stops a clip while its fal %s discovery request is reading",
    async (stage) => {
      const control = new AbortController();
      const reading = Promise.withResolvers<void>();
      const requests: Array<VideoHttpRequest> = [];
      const adapter = falVideoDriver.create({
        profile,
        ports: {
          ...ports(script()).ports,
          request: async (request) => {
            requests.push(request);
            const inPricing = new URL(request.url).pathname.endsWith("/pricing");
            if (inPricing !== (stage === "pricing")) return script()(request);
            reading.resolve();
            const signal = request.signal;
            if (signal === undefined) return script()(request);
            return new Promise((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject({ category: "interrupted", message: "Stopped." }),
                { once: true },
              ),
            );
          },
        },
      });
      const pending = adapter.start({
        modelId: veo,
        prompt: "A boat",
        options,
        references: [],
        signal: control.signal,
      });
      await reading.promise;
      control.abort();
      expect(await pending).toMatchObject({
        status: "failed",
        providerFailure: { category: "interrupted" },
      });
      expect(requests).toHaveLength(stage === "pricing" ? 1 : 2);
      expect(requests.every((request) => request.signal === control.signal)).toBe(true);
    },
  );

  it("retries removal when fal reports that a CDN file could not be deleted", async () => {
    const respond = vi
      .fn()
      .mockImplementationOnce(() =>
        Response.json({
          cdn_delete_results: [
            { link: "https://v3b.fal.media/files/preview.png", exception: null },
            { link: "https://v3b.fal.media/files/clip.mp4", exception: "Deletion failed" },
          ],
        }),
      )
      .mockImplementationOnce(() =>
        Response.json({
          cdn_delete_results: [{ link: "https://v3b.fal.media/files/clip.mp4", exception: null }],
        }),
      );
    const adapter = falVideoDriver.create({ profile, ports: ports(respond).ports });
    const remoteId = `fal-ai/veo3.1#${requestId}`;
    expect(await adapter.forget(remoteId)).toMatchObject({
      status: "failed",
      providerFailure: { category: "unavailable" },
    });
    expect(await adapter.forget(remoteId)).toEqual({ status: "removed" });
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

  it("passes the caller's signal through the PUT and the follow-up poll", async () => {
    const sent: Array<VideoHttpRequest> = [];
    const adapter = falVideoDriver.create({
      profile,
      ports: {
        request: async (request) => {
          sent.push(request);
          const signal = request.signal;
          if (signal?.aborted === true) throw signal.reason;
          // A 400 means the runner is already done, so cancel reads the job's
          // status — a read the network never answers until the caller aborts.
          if (request.method === "PUT") return new Response(null, { status: 400 });
          await new Promise<never>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason)),
          );
          return Response.json({});
        },
        fetchApprovedVideoUrl: async () => ({ bytes: CONFORMANCE_MP4_BYTES }),
        sniffMediaType: (bytes) => (looksLikeMp4(bytes) ? "video/mp4" : undefined),
      },
    });
    const control = new AbortController();
    const pending = adapter.cancel(`fal-ai/veo3.1#${requestId}`, control.signal);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    control.abort();
    const answer = await pending;
    expect(sent[0]?.signal).toBe(control.signal);
    expect(sent[1]?.signal).toBe(control.signal);
    expect(answer.status).toBe("failed");
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
                  // Wan's live schema makes the rate selectable (4-60 or
                  // null); the adapter pins its choice in the submit body.
                  frames_per_second: {
                    anyOf: [{ type: "integer", minimum: 4, maximum: 60 }, { type: "null" }],
                    default: 16,
                  },
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

  it("still offers the endpoints that exist when one configured id is gone", async () => {
    const gone = decodeProviderModelId("fal-ai/no-such-model");
    const adapter = falVideoDriver.create({
      profile: { ...profile, modelIds: [veo, gone] },
      ports: ports((request) => {
        const url = new URL(request.url);
        if (url.hostname === "fal.ai") {
          const endpoint = url.searchParams.get("endpoint_id") ?? "";
          if (endpoint === "fal-ai/no-such-model") return new Response(null, { status: 404 });
          return Response.json(schema(endpoint, endpoint.endsWith("image-to-video")));
        }
        if (url.hostname === "api.fal.ai") return Response.json({ prices: [] });
        return new Response(null, { status: 500 });
      }).ports,
    });
    const models = await adapter.models();
    expect(models.map((model) => model.modelId)).toEqual(["fal-ai/veo3.1"]);
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
    const adapter = falVideoDriver.create({
      profile,
      ports: {
        ...recorder.ports,
        fetchApprovedVideoUrl: async () => {
          fetched += 1;
          return { bytes: CONFORMANCE_MP4_BYTES };
        },
      },
    });
    const polled = await adapter.poll(`fal-ai/veo3.1#${requestId}`, new AbortController().signal);
    expect(polled.status).toBe("failed");
    expect(polled).not.toHaveProperty("billed");
    expect(fetched).toBe(0);
  });

  it("keeps the reported charge when a result has no clip address", async () => {
    const recorder = ports((request) =>
      new URL(request.url).pathname.endsWith("/status")
        ? Response.json({ status: "COMPLETED" })
        : Response.json({ video: {} }, { headers: { "x-fal-billable-units": "8" } }),
    );
    const adapter = falVideoDriver.create({ profile, ports: recorder.ports });
    expect(
      await adapter.poll(`fal-ai/veo3.1#${requestId}`, new AbortController().signal),
    ).toMatchObject({
      status: "failed",
      providerFailure: { category: "protocol" },
      billed: true,
      usage: { billedSeconds: 8 },
    });
  });

  it.each([undefined, "8"])(
    "keeps the charge for a completed clip with invalid bytes and %s billable units",
    async (units) => {
      const recorder = ports((request) => {
        if (new URL(request.url).pathname.endsWith("/status")) {
          return Response.json({ status: "COMPLETED" });
        }
        return Response.json(
          { video: { url: "https://v3b.fal.media/files/clip.mp4" } },
          {
            headers: units === undefined ? {} : { "x-fal-billable-units": units },
          },
        );
      });
      const adapter = falVideoDriver.create({
        profile,
        ports: {
          ...recorder.ports,
          fetchApprovedVideoUrl: async () => ({ bytes: new Uint8Array([0]) }),
        },
      });
      expect(
        await adapter.poll(`fal-ai/veo3.1#${requestId}`, new AbortController().signal),
      ).toEqual({
        status: "failed",
        providerFailure: {
          category: "protocol",
          message: "fal returned a clip that is not an MP4.",
        },
        billed: true,
        ...(units === undefined ? {} : { usage: { billedSeconds: 8 } }),
      });
    },
  );

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
