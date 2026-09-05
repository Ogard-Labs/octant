import { decodeProviderInstance, type OpenAiCompatibleProviderInstance } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { makeOpenAiCompatibleSpeechAdapter } from "./speechAdapter";

const now = "2026-09-05T10:00:00.000Z";

function instance(
  overrides: Partial<OpenAiCompatibleProviderInstance["configuration"]> = {},
): OpenAiCompatibleProviderInstance {
  const decoded = decodeProviderInstance({
    id: "00000000-0000-4000-8000-00000000c001",
    displayName: "OpenAI",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.openai.com/v1/",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
      ...overrides,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (decoded.driverKind !== "openai-compatible") throw new Error("expected compatible");
  return decoded;
}

const credentialResolver = {
  has: async () => true,
  resolve: async () => "sk-test",
};

const wav = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVEfmt ")]);

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
>;

function firstCall(fetch: FetchMock): { readonly url: string; readonly init: RequestInit } {
  const call = fetch.mock.calls[0];
  if (call === undefined || call[1] === undefined) throw new Error("fetch was not called");
  return { url: String(call[0]), init: call[1] };
}

describe("OpenAI-compatible speech adapter", () => {
  it("posts the clip as multipart to the instance's own audio path with its credential", async () => {
    const fetch: FetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "  hello there  " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = makeOpenAiCompatibleSpeechAdapter({
      instance: instance(),
      credentialResolver,
      fetch,
    });

    const result = await adapter.transcribe({
      audio: wav,
      mediaType: "audio/wav",
      modelId: "whisper-1" as never,
      language: "nb",
    });

    expect(result).toEqual({ status: "completed", text: "hello there" });
    const { url, init } = firstCall(fetch);
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("language")).toBe("nb");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("recording.wav");
    expect((file as Blob).type).toBe("audio/wav");
  });

  it("speaks to an unauthenticated loopback instance without inventing a credential", async () => {
    const fetch: FetchMock = vi.fn(
      async () => new Response(JSON.stringify({ text: "local" }), { status: 200 }),
    );
    const adapter = makeOpenAiCompatibleSpeechAdapter({
      instance: instance({ baseUrl: "http://127.0.0.1:8000/v1", authentication: "none" }),
      fetch,
    });

    const result = await adapter.transcribe({
      audio: wav,
      mediaType: "audio/wav",
      modelId: "whisper-large-v3" as never,
    });

    expect(result).toEqual({ status: "completed", text: "local" });
    const { url, init } = firstCall(fetch);
    expect(url).toBe("http://127.0.0.1:8000/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("classifies an endpoint that has no audio route as unsupported, and a bad body as protocol", async () => {
    const missing = makeOpenAiCompatibleSpeechAdapter({
      instance: instance(),
      credentialResolver,
      fetch: async () => new Response("not found", { status: 404 }),
    });
    expect(
      await missing.transcribe({ audio: wav, mediaType: "audio/wav", modelId: "x" as never }),
    ).toMatchObject({ status: "failed", providerFailure: { category: "unsupported" } });

    const garbage = makeOpenAiCompatibleSpeechAdapter({
      instance: instance(),
      credentialResolver,
      fetch: async () => new Response(JSON.stringify({ transcript: 42 }), { status: 200 }),
    });
    expect(
      await garbage.transcribe({ audio: wav, mediaType: "audio/wav", modelId: "x" as never }),
    ).toMatchObject({ status: "failed", providerFailure: { category: "protocol" } });

    const missingKey = makeOpenAiCompatibleSpeechAdapter({
      instance: instance(),
      credentialResolver: { has: async () => false, resolve: async () => "" },
      fetch: async () => new Response("{}", { status: 200 }),
    });
    expect(
      await missingKey.transcribe({ audio: wav, mediaType: "audio/wav", modelId: "x" as never }),
    ).toMatchObject({ status: "failed", providerFailure: { category: "unauthenticated" } });
  });

  it("returns synthesized bytes in the requested format and refuses an empty body", async () => {
    const audio = Uint8Array.from([1, 2, 3, 4]);
    const fetch: FetchMock = vi.fn(
      async () => new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    );
    const adapter = makeOpenAiCompatibleSpeechAdapter({
      instance: instance(),
      credentialResolver,
      fetch,
    });

    const result = await adapter.synthesize({
      text: "Hello",
      modelId: "gpt-4o-mini-tts" as never,
      voice: "alloy" as never,
      format: "mp3",
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.mediaType).toBe("audio/mpeg");
    expect([...result.bytes]).toEqual([1, 2, 3, 4]);
    const { url, init } = firstCall(fetch);
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Hello",
      voice: "alloy",
      response_format: "mp3",
    });

    const empty = makeOpenAiCompatibleSpeechAdapter({
      instance: instance(),
      credentialResolver,
      fetch: async () => new Response(new Uint8Array(0), { status: 200 }),
    });
    expect(
      await empty.synthesize({
        text: "Hello",
        modelId: "tts-1" as never,
        voice: "alloy" as never,
        format: "wav",
      }),
    ).toMatchObject({ status: "failed", providerFailure: { category: "protocol" } });
  });
});
