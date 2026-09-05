import { describe, expect, it, vi } from "vitest";
import { createSpeechClient, SpeechClientFailure } from "./speechClient";

const compatibleId = "00000000-0000-4000-8000-00000000c001";

describe("createSpeechClient", () => {
  it("reads status and sends a clip as multipart with the window capability", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/speech/status")) {
        return new Response(
          JSON.stringify({
            transcription: { status: "ready", providerInstanceId: compatibleId, modelId: "w" },
            synthesis: {
              status: "unconfigured",
              settingsTarget: { section: "voice", setting: "synthesis" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("language")).toBe("en");
      expect((form.get("audio") as Blob).size).toBe(3);
      return new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createSpeechClient({
      baseUrl: "http://127.0.0.1:3100",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });

    const status = await client.status();
    expect(status.transcription.status).toBe("ready");
    expect(status.synthesis.status).toBe("unconfigured");

    const transcript = await client.transcribe({
      audio: new Blob([Uint8Array.from([1, 2, 3])], { type: "audio/wav" }),
      language: "en",
    });
    expect(transcript.text).toBe("hello");
    for (const call of fetch.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers["x-octant-window-capability"]).toBe("cap");
    }
  });

  it("carries the host's refusal category and Settings link on a failure", async () => {
    const client = createSpeechClient({
      baseUrl: "http://127.0.0.1:3100",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            error: "Transcription is not configured.",
            category: "unconfigured",
            settingsTarget: { section: "voice", setting: "transcription" },
          }),
          { status: 412, headers: { "content-type": "application/json" } },
        )) as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });

    const failure = await client
      .transcribe({ audio: new Blob([Uint8Array.from([1])]) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpeechClientFailure);
    expect(failure).toMatchObject({
      status: 412,
      category: "unconfigured",
      message: "Transcription is not configured.",
      settingsTarget: { section: "voice", setting: "transcription" },
    });
  });

  it("returns synthesized audio as a blob and refuses a non-audio body", async () => {
    const client = createSpeechClient({
      baseUrl: "http://127.0.0.1:3100",
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { text: string };
        return body.text === "html"
          ? new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })
          : new Response(Uint8Array.from([1, 2]), {
              status: 200,
              headers: { "content-type": "audio/mpeg" },
            });
      }) as unknown as typeof globalThis.fetch,
      windowCapability: "cap",
    });

    const audio = await client.synthesize({ text: "Hello", format: "mp3" });
    expect(audio.mediaType).toBe("audio/mpeg");
    expect(audio.bytes.size).toBe(2);

    await expect(client.synthesize({ text: "html" })).rejects.toMatchObject({
      category: "protocol",
    });
  });
});
