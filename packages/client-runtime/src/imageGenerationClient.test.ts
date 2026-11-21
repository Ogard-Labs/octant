import { describe, expect, it, vi } from "vitest";
import { createImageGenerationClient, createThreadImageResults } from "./imageGenerationClient";
import {
  THREAD_IMAGE_CHUNK_BYTES,
  decodeImageJobId,
  decodeImageArtifactId,
} from "@octant/contracts";

const profileId = "a3000000-0000-4000-8000-000000000001";
const scopeId = "a3000000-0000-4000-8000-000000000002";
const jobId = "a3000000-0000-4000-8000-000000000003";
const now = "2026-08-28T12:00:00.000Z";

function job() {
  return {
    id: jobId,
    status: "queued",
    threadKind: "chat-thread",
    scopeId,
    profileInstanceId: profileId,
    modelId: "gpt-image-2",
    promptHash: "a".repeat(64),
    artifacts: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("createImageGenerationClient", () => {
  it("downloads paired images larger than a remote response without returning truncated bytes", async () => {
    const size = THREAD_IMAGE_CHUNK_BYTES * 2 + 3;
    let truncate = false;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/image/thread-artifact");
      const offset = Number(url.searchParams.get("offset"));
      const end = Math.min(offset + THREAD_IMAGE_CHUNK_BYTES, size);
      return new Response(new Uint8Array(end - offset - (truncate ? 1 : 0)), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-range": `bytes ${offset}-${end - 1}/${size}`,
        },
      });
    });
    const client = createThreadImageResults({
      baseUrl: "http://127.0.0.1",
      fetch,
      windowCapability: "fixture",
    });
    const read = () => client.artifact(decodeImageJobId(jobId), decodeImageArtifactId(scopeId));
    const image = await read();
    expect(image.size).toBe(size);
    expect(image.type).toBe("image/png");
    expect(fetch).toHaveBeenCalledTimes(3);
    truncate = true;
    await expect(read()).rejects.toThrow("incomplete");
  });
  it("lists profiles and enqueues a job", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/image/profiles")) {
        return new Response(
          JSON.stringify({
            profiles: [
              {
                instanceId: profileId,
                displayName: "OpenAI Image",
                driverKind: "openai-image",
                modelAllowlist: ["gpt-image-2"],
                defaultModel: "gpt-image-2",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(job()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createImageGenerationClient({
      baseUrl: "http://127.0.0.1:3100",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "token",
    });
    const profiles = await client.profiles();
    expect(profiles.profiles[0]?.displayName).toBe("OpenAI Image");
    const queued = await client.enqueue({
      threadKind: "chat-thread",
      scopeId: scopeId as never,
      profileInstanceId: profileId as never,
      modelId: "gpt-image-2" as never,
      prompt: "a red cube",
    });
    expect(queued.status).toBe("queued");
  });
});
