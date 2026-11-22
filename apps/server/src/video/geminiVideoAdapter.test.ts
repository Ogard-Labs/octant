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
import { geminiVideoDriver } from "./geminiVideoAdapter";

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
        { type: "text", text: "Bring this drawing to life" },
      ],
      response_format: { type: "video", aspect_ratio: "16:9", resolution: "720p", duration: "8s" },
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
      expect(["@octant/contracts", "@octant/provider-sdk/video-generation"]).toContain(specifier);
    }
  });
});
