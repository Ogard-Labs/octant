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
import { geminiVideoDriver, promptWithImageRoles } from "./geminiVideoAdapter";

const modelId = decodeProviderModelId("gemini-omni-1.2-flash");
const profile = {
  instanceId: decodeProviderInstanceId("00000000-0000-4000-8000-0000000000c1"),
  modelIds: [modelId],
};
const clipBase64 = Buffer.from(CONFORMANCE_MP4_BYTES).toString("base64");
const options = { durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", audio: true };
const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" as const };

function completedInteraction(extra: Record<string, unknown> = {}) {
  return {
    id: "v1_abc",
    status: "completed",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "..." }] },
      {
        type: "model_output",
        content: [{ type: "video", mime_type: "video/mp4", data: clipBase64 }],
      },
    ],
    usage: { total_input_tokens: 12, total_output_tokens: 46_336, total_thought_tokens: 40 },
    ...extra,
  };
}

function script(): (request: VideoHttpRequest) => Response {
  let polls = 0;
  return (request) => {
    if (request.method === "POST" && request.url.endsWith("/interactions")) {
      return Response.json({ id: "v1_abc", status: "in_progress" });
    }
    if (request.method === "POST" && request.url.endsWith("/cancel")) {
      return Response.json({ id: "v1_abc", status: "cancelled" });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    polls += 1;
    return Response.json(
      polls < 2 ? { id: "v1_abc", status: "in_progress" } : completedInteraction(),
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

describe("Gemini video driver", () => {
  it("keeps every promise of the video seam", async () => {
    await expect(
      runVideoGenerationConformance({
        driver: geminiVideoDriver,
        profile,
        request: { modelId, prompt: "A paper boat on a pond", options, references: [] },
        respond: script,
      }),
    ).resolves.toMatchObject({ cancelAndForgetResolve: true });
  });

  it("starts a background interaction with the chosen clip options and its images first", async () => {
    const recorder = ports(script());
    const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId,
      prompt: "Bring this drawing to life",
      options,
      firstFrame: png,
      references: [png],
      signal: new AbortController().signal,
    });
    expect(started).toEqual({ status: "started", remoteId: "v1_abc" });
    const sent = recorder.sent[0];
    expect(sent?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(sent?.auth).toEqual({ header: "x-goog-api-key" });
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      model: "gemini-omni-1.2-flash",
      input: [
        { type: "image", data: "iVBORw==", mime_type: "image/png" },
        { type: "image", data: "iVBORw==", mime_type: "image/png" },
        {
          type: "text",
          text: "Use image 1 as the first frame of the clip. Use image 2 only as a reference for the subjects, not as a frame.\n\nBring this drawing to life",
        },
      ],
      response_format: {
        type: "video",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: "8s",
        delivery: "uri",
      },
      background: true,
      store: true,
    });
  });

  it("reports Google's token counts, thinking included, with the finished clip", async () => {
    const adapter = geminiVideoDriver.create({ profile, ports: ports(script()).ports });
    await adapter.poll("v1_abc", new AbortController().signal);
    const done = await adapter.poll("v1_abc", new AbortController().signal);
    expect(done).toMatchObject({
      status: "completed",
      usage: { outputTokens: 46_376, inputTokens: 12 },
    });
  });

  it("refuses a first-and-last-frame clip over ten seconds before calling Google", async () => {
    const recorder = ports(script());
    const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
    const started = await adapter.start({
      modelId,
      prompt: "Forest at dawn to forest at night",
      options: { ...options, durationSeconds: 12 },
      firstFrame: png,
      lastFrame: png,
      references: [],
      signal: new AbortController().signal,
    });
    expect(started.status).toBe("failed");
    expect(recorder.sent).toHaveLength(0);
  });

  it("tells Google which image opens the clip, which ends it, and which only guide the subjects", () => {
    const asFrames = promptWithImageRoles("A boat", {
      firstFrame: true,
      lastFrame: true,
      references: 0,
    });
    const asReferences = promptWithImageRoles("A boat", {
      firstFrame: false,
      lastFrame: false,
      references: 2,
    });
    expect(asFrames).toBe(
      "Use image 1 as the first frame of the clip. Use image 2 as the last frame of the clip.\n\nA boat",
    );
    expect(asReferences).toBe(
      "Use images 1 to 2 only as references for the subjects, not as frames.\n\nA boat",
    );
    expect(
      promptWithImageRoles("A boat", { firstFrame: false, lastFrame: true, references: 0 }),
    ).toBe("Use image 1 as the last frame of the clip.\n\nA boat");
  });

  it.each([
    "https://generativelanguage.googleapis.com/v1beta/files/clip-9:download?alt=media",
    "files/clip-9",
  ])("downloads a clip Google delivered as a file once the file is ready (%s)", async (uri) => {
    let fileChecks = 0;
    const recorder = ports((request) => {
      if (request.url.endsWith("/interactions/v1_abc")) {
        return Response.json(
          completedInteraction({
            steps: [
              {
                type: "model_output",
                content: [
                  {
                    type: "video",
                    mime_type: "video/mp4",
                    uri,
                  },
                ],
              },
            ],
          }),
        );
      }
      if (request.url.endsWith("/files/clip-9")) {
        fileChecks += 1;
        return Response.json({ state: fileChecks < 2 ? "PROCESSING" : "ACTIVE" });
      }
      if (request.url.endsWith("/files/clip-9:download?alt=media")) {
        return new Response(CONFORMANCE_MP4_BYTES);
      }
      return new Response(null, { status: 404 });
    });
    const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
    expect((await adapter.poll("v1_abc", new AbortController().signal)).status).toBe("running");
    expect(await adapter.poll("v1_abc", new AbortController().signal)).toMatchObject({
      status: "completed",
      video: { mediaType: "video/mp4" },
    });
    expect(recorder.sent.every((request) => request.auth.header === "x-goog-api-key")).toBe(true);
  });

  it.each(["info", "bytes"])(
    "keeps a finished clip running when its download request throws (%s)",
    async (which) => {
      const recorder = ports((request) => {
        if (request.url.endsWith("/interactions/v1_abc")) {
          return Response.json(
            completedInteraction({
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "video", mime_type: "video/mp4", uri: "files/clip-9" }],
                },
              ],
            }),
          );
        }
        if (which === "info" || request.url.endsWith(":download?alt=media")) {
          throw new Error("connection reset");
        }
        return Response.json({ state: "ACTIVE" });
      });
      const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
      expect(await adapter.poll("v1_abc", new AbortController().signal)).toEqual({
        status: "running",
      });
    },
  );

  it("keeps a finished clip it could not download running, so it is tried again and stays billed", async () => {
    const recorder = ports((request) =>
      request.url.endsWith("/interactions/v1_abc")
        ? Response.json(
            completedInteraction({
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "video", mime_type: "video/mp4", uri: "files/clip-9" }],
                },
              ],
            }),
          )
        : new Response(null, { status: 503 }),
    );
    const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
    expect(await adapter.poll("v1_abc", new AbortController().signal)).toEqual({
      status: "running",
    });
  });

  it("retries a poll body that breaks mid-read, while bad JSON stays a protocol failure", async () => {
    let calls = 0;
    const recorder = ports(() => {
      calls += 1;
      // Headers arrive, then the stream dies: a transport break, not bad JSON.
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":'));
              controller.error(new Error("stream reset"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (calls === 2) return new Response("{not json", { status: 200 });
      return Response.json(completedInteraction());
    });
    const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
    expect(await adapter.poll("v1_abc", new AbortController().signal)).toMatchObject({
      status: "failed",
      providerFailure: { category: "unavailable" },
    });
    expect(await adapter.poll("v1_abc", new AbortController().signal)).toMatchObject({
      status: "failed",
      providerFailure: { category: "protocol" },
    });
    expect((await adapter.poll("v1_abc", new AbortController().signal)).status).toBe("completed");
  });

  it("calls a completed interaction with no clip a safety refusal", async () => {
    const adapter = geminiVideoDriver.create({
      profile,
      ports: ports(() => Response.json(completedInteraction({ steps: [] }))).ports,
    });
    expect((await adapter.poll("v1_abc", new AbortController().signal)).status).toBe("refused");
  });

  it("treats a delete of an interaction Google no longer has as removed", async () => {
    const adapter = geminiVideoDriver.create({
      profile,
      ports: ports(() => new Response(null, { status: 404 })).ports,
    });
    expect(await adapter.forget("v1_abc")).toEqual({ status: "removed" });
  });

  it("never puts an id Google did not shape into a URL path", async () => {
    const recorder = ports(script());
    const adapter = geminiVideoDriver.create({ profile, ports: recorder.ports });
    expect((await adapter.poll("../files/x", new AbortController().signal)).status).toBe("failed");
    expect((await adapter.forget("a/b")).status).toBe("failed");
    expect(recorder.sent).toHaveLength(0);
  });

  it("declares only the models the person enabled on the profile", async () => {
    const adapter = geminiVideoDriver.create({
      profile: { ...profile, modelIds: [decodeProviderModelId("some-other-model")] },
      ports: ports(script()).ports,
    });
    expect(await adapter.models()).toEqual([]);
  });

  it("keeps to the imports a third-party video plugin could make", () => {
    const source = readFileSync(join(import.meta.dirname, "geminiVideoAdapter.ts"), "utf8");
    const specifiers = [
      ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"|\brequire\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect([
        "@octant/contracts",
        "@octant/contracts/video-generation",
        "@octant/provider-sdk/video-generation",
      ]).toContain(specifier);
    }
  });
});
