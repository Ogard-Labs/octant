import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import {
  settleVideoCostUsdMicros,
  type VideoGenerationPorts,
  type VideoHttpRequest,
} from "@octant/provider-sdk/video-generation";
import {
  CONFORMANCE_MP4_BYTES,
  looksLikeMp4,
  runVideoGenerationConformance,
} from "@octant/provider-sdk/video-generation-conformance";
import { describe, expect, it } from "vitest";
import { RUNWAY_GEN45, runwayVideoDriver } from "./runwayVideoAdapter";

const taskId = "17f20503-6c24-4c16-946b-35dbbce2af2f";
const gen45 = decodeProviderModelId("gen4.5");
const turbo = decodeProviderModelId("gen4_turbo");
const profile = {
  instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-0000000000d1"),
  modelIds: [gen45, turbo],
};
const options = { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audio: false };
const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" as const };

function succeeded(extra: Record<string, unknown> = {}) {
  return {
    id: taskId,
    status: "SUCCEEDED",
    output: ["https://cdn.runway.example/clip.mp4"],
    cost: { credits: 60 },
    ...extra,
  };
}

function script(): (request: VideoHttpRequest) => Response {
  let polls = 0;
  return (request) => {
    if (request.method === "POST") return Response.json({ id: taskId });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    polls += 1;
    return Response.json(polls < 2 ? { id: taskId, status: "RUNNING" } : succeeded());
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

describe("Runway video driver", () => {
  it("keeps every promise of the video seam", async () => {
    await expect(
      runVideoGenerationConformance({
        driver: runwayVideoDriver,
        profile,
        request: { modelId: gen45, prompt: "A paper boat on a pond", options, references: [] },
        respond: script,
      }),
    ).resolves.toMatchObject({ cancelAndForgetResolve: true });
  });

  it("sends text to text-to-video and a first frame to image-to-video, with Runway's version", async () => {
    const recorder = ports(script());
    const adapter = runwayVideoDriver.create({ profile, ports: recorder.ports });
    await adapter.start({
      modelId: gen45,
      prompt: "A boat",
      options,
      references: [],
      signal: new AbortController().signal,
    });
    await adapter.start({
      modelId: gen45,
      prompt: "A boat",
      options: { ...options, aspectRatio: "1:1" },
      firstFrame: png,
      references: [],
      signal: new AbortController().signal,
    });
    const [text, image] = recorder.sent;
    expect(text?.url).toBe("https://api.dev.runwayml.com/v1/text_to_video");
    expect(JSON.parse(text?.body ?? "{}")).toEqual({
      model: "gen4.5",
      promptText: "A boat",
      ratio: "1280:720",
      duration: 5,
    });
    expect(image?.url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
    expect(JSON.parse(image?.body ?? "{}")).toMatchObject({
      ratio: "960:960",
      promptImage: [{ uri: "data:image/png;base64,iVBORw==", position: "first" }],
    });
    expect(
      recorder.sent.every((request) => request.headers?.["x-runway-version"] === "2024-11-06"),
    ).toBe(true);
  });

  it("refuses a text-only Gen-4 Turbo clip before calling Runway, since it needs a first frame", async () => {
    const recorder = ports(script());
    const adapter = runwayVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId: turbo,
      prompt: "A boat",
      options,
      references: [],
      signal: new AbortController().signal,
    });
    expect(started.status).toBe("failed");
    expect(recorder.sent).toHaveLength(0);
  });

  it("settles from the credits Runway charged, and keeps the charge on a moderation refusal", async () => {
    const done = runwayVideoDriver.create({
      profile,
      ports: ports(() => Response.json(succeeded())).ports,
    });
    const completed = await done.poll(taskId, new AbortController().signal);
    expect(completed).toMatchObject({ status: "completed", usage: { costUsdMicros: 600_000 } });
    expect(
      settleVideoCostUsdMicros(RUNWAY_GEN45.price, 999_999, { costUsdMicros: 600_000 }, options, {
        imageCount: 0,
      }),
    ).toBe(600_000);

    const refused = runwayVideoDriver.create({
      profile,
      ports: ports(() =>
        Response.json({
          id: taskId,
          status: "FAILED",
          failureCode: "SAFETY.INPUT.TEXT",
          cost: { credits: 60 },
        }),
      ).ports,
    });
    expect(await refused.poll(taskId, new AbortController().signal)).toMatchObject({
      status: "refused",
      usage: { costUsdMicros: 600_000 },
    });
  });

  it.each([
    { code: "SAFETY.INPUT.TEXT", billed: true },
    { code: "SAFETY.OUTPUT.VIDEO", billed: undefined },
    { code: "INPUT_PREPROCESSING.SAFETY.TEXT", billed: undefined },
  ])("preserves refund semantics for a $code refusal with no cost", async ({ code, billed }) => {
    const adapter = runwayVideoDriver.create({
      profile,
      ports: ports(() => Response.json({ id: taskId, status: "FAILED", failureCode: code })).ports,
    });
    expect(await adapter.poll(taskId, new AbortController().signal)).toEqual({
      status: "refused",
      safetyRefusal: "Runway's content moderation blocked this clip.",
      ...(billed === true ? { billed } : {}),
    });
  });

  it("keeps a finished clip it could not download running, so the next poll tries again", async () => {
    const recorder = ports(() => Response.json(succeeded()));
    const adapter = runwayVideoDriver.create({
      profile,
      ports: {
        ...recorder.ports,
        fetchApprovedVideoUrl: async () => ({
          failure: { category: "unavailable", message: "Try later." },
        }),
      },
    });
    expect(await adapter.poll(taskId, new AbortController().signal)).toEqual({ status: "running" });
  });

  it.each([undefined, 60])(
    "keeps the charge for a completed clip with invalid bytes and %s credits",
    async (credits) => {
      const recorder = ports(() => Response.json(succeeded({ cost: { credits } })));
      const adapter = runwayVideoDriver.create({
        profile,
        ports: {
          ...recorder.ports,
          fetchApprovedVideoUrl: async () => ({ bytes: png.bytes }),
        },
      });
      expect(await adapter.poll(taskId, new AbortController().signal)).toEqual({
        status: "failed",
        providerFailure: {
          category: "protocol",
          message: "Runway returned a clip that is not an MP4.",
        },
        billed: true,
        ...(credits === undefined ? {} : { usage: { costUsdMicros: 600_000 } }),
      });
    },
  );

  it("keeps the charge when a successful task has no clip address", async () => {
    const adapter = runwayVideoDriver.create({
      profile,
      ports: ports(() => Response.json(succeeded({ output: [] }))).ports,
    });
    expect(await adapter.poll(taskId, new AbortController().signal)).toMatchObject({
      status: "failed",
      billed: true,
      usage: { costUsdMicros: 600_000 },
    });
  });

  it("never puts an id Runway did not shape into a URL path", async () => {
    const recorder = ports(script());
    const adapter = runwayVideoDriver.create({ profile, ports: recorder.ports });
    expect((await adapter.poll("../organization", new AbortController().signal)).status).toBe(
      "failed",
    );
    expect(recorder.sent).toHaveLength(0);
  });

  it("refuses a first frame in a format Runway cannot take before calling it", async () => {
    const recorder = ports(script());
    const adapter = runwayVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId: gen45,
      prompt: "A boat",
      options,
      firstFrame: { bytes: new Uint8Array([0x47, 0x49, 0x46]), mediaType: "image/gif" },
      references: [],
      signal: new AbortController().signal,
    });
    expect(started.status).toBe("failed");
    expect(recorder.sent).toHaveLength(0);
  });

  it("keeps the estimate for a cancellation without usage and uses a reported charge", async () => {
    const adapter = runwayVideoDriver.create({
      profile,
      ports: ports(() => new Response(null, { status: 204 })).ports,
    });
    const cancelled = await adapter.cancel(taskId);
    expect(cancelled).toEqual({ status: "cancelled" });

    const polled = runwayVideoDriver.create({
      profile,
      ports: ports(() => Response.json({ id: taskId, status: "CANCELLED", cost: { credits: 60 } }))
        .ports,
    });
    expect(await polled.poll(taskId, new AbortController().signal)).toEqual({
      status: "cancelled",
      usage: { costUsdMicros: 600_000 },
    });
  });

  it("reports no usage for a cancelled task Runway states no charge for, so the estimate settles", async () => {
    const adapter = runwayVideoDriver.create({
      profile,
      ports: ports(() => Response.json({ id: taskId, status: "CANCELLED" })).ports,
    });
    expect(await adapter.poll(taskId, new AbortController().signal)).toEqual({
      status: "cancelled",
    });
  });

  it("passes the caller's signal to the DELETE so an abort ends a stuck request", async () => {
    const sent: Array<VideoHttpRequest> = [];
    const adapter = runwayVideoDriver.create({
      profile,
      ports: {
        request: async (request) => {
          sent.push(request);
          const signal = request.signal;
          if (signal?.aborted === true) throw signal.reason;
          // A request the network never answers, until the caller gives up.
          await new Promise<never>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason)),
          );
          return new Response(null, { status: 204 });
        },
        fetchApprovedVideoUrl: async () => ({ bytes: CONFORMANCE_MP4_BYTES }),
        sniffMediaType: (bytes) => (looksLikeMp4(bytes) ? "video/mp4" : undefined),
      },
    });
    const control = new AbortController();
    const pending = adapter.cancel(taskId, control.signal);
    control.abort();
    const answer = await pending;
    expect(sent[0]?.method).toBe("DELETE");
    expect(sent[0]?.signal).toBe(control.signal);
    expect(answer.status).toBe("failed");
  });

  it("keeps to the imports a third-party video plugin could make", () => {
    const source = readFileSync(join(import.meta.dirname, "runwayVideoAdapter.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"|\brequire\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(["@octant/contracts", "@octant/provider-sdk/video-generation"]).toContain(specifier);
    }
  });
});
