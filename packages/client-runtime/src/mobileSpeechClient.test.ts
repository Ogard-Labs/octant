import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { readMobileTranscriptionReadiness, transcribeMobileClip } from "./mobileSpeechClient";

type FetchInput = Parameters<MobileRemoteTransport["authenticatedFetch"]>[0];

function transportAnswering(answer: (input: FetchInput) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: FetchInput) => answer(input));
  const transport: MobileRemoteTransport = {
    hostId: "77000000-0000-4000-8000-0000000000ff",
    authenticatedFetch: fetch,
  };
  return { transport, fetch };
}

const m4a = Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode("ftypM4A "), 1, 2, 3, 4]);

describe("dictation from a paired phone", () => {
  it("offers dictation only when the host says transcription is ready", async () => {
    const ready = transportAnswering(() =>
      Response.json({
        transcription: {
          status: "ready",
          providerInstanceId: "77000000-0000-4000-8000-000000000001",
          modelId: "whisper-1",
        },
        synthesis: {
          status: "unavailable",
          reason: "Read-aloud is available only on the computer itself.",
          settingsTarget: { section: "voice", setting: "synthesis" },
        },
      }),
    );
    await expect(readMobileTranscriptionReadiness({ transport: ready.transport })).resolves.toBe(
      "ready",
    );
    expect(ready.fetch.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/api/speech/status",
    });

    const unconfigured = transportAnswering(() =>
      Response.json({
        transcription: {
          status: "unconfigured",
          settingsTarget: { section: "voice", setting: "transcription" },
        },
        synthesis: {
          status: "unconfigured",
          settingsTarget: { section: "voice", setting: "synthesis" },
        },
      }),
    );
    await expect(
      readMobileTranscriptionReadiness({ transport: unconfigured.transport }),
    ).resolves.toBe("unconfigured");

    // A host that refuses, cannot be reached, or answers off-contract is not ready.
    for (const answer of [
      () => new Response(null, { status: 404 }),
      () => Response.json({ transcription: "ready" }),
      () => Promise.reject(new Error("offline")),
    ]) {
      const host = transportAnswering(answer);
      await expect(readMobileTranscriptionReadiness({ transport: host.transport })).resolves.toBe(
        "unavailable",
      );
    }
  });

  it("sends the clip as the multipart upload the host reads and returns only its text", async () => {
    const { transport, fetch } = transportAnswering(() => Response.json({ text: "Ship it." }));
    const result = await transcribeMobileClip({ transport, audio: m4a, mediaType: "audio/mp4" });
    expect(result).toEqual({ status: "transcribed", text: "Ship it." });

    const sent = fetch.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ method: "POST", path: "/api/speech/transcriptions" });
    expect(sent?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const sentBody = sent?.body;
    if (!(sentBody instanceof Uint8Array)) throw new Error("The clip was not sent as bytes.");
    const form = await new Response(Uint8Array.from(sentBody), {
      headers: { "content-type": sent?.contentType ?? "" },
    }).formData();
    const audio = form.get("audio");
    expect(audio).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (audio as Blob).arrayBuffer())).toEqual(m4a);
    expect([...form.keys()]).toEqual(["audio"]);
  });

  it("returns the host's refusal as a value the composer can show", async () => {
    const overBudget = transportAnswering(() =>
      Response.json(
        {
          error: "This device has used its voice allowance for now. Try again later.",
          category: "rate-limited",
          retryAfterMs: 60_000,
        },
        { status: 429 },
      ),
    );
    await expect(
      transcribeMobileClip({ transport: overBudget.transport, audio: m4a, mediaType: "audio/mp4" }),
    ).resolves.toEqual({
      status: "refused",
      category: "rate-limited",
      message: "This device has used its voice allowance for now. Try again later.",
      retryAfterMs: 60_000,
    });

    const unreachable = transportAnswering(() => Promise.reject(new Error("offline")));
    await expect(
      transcribeMobileClip({
        transport: unreachable.transport,
        audio: m4a,
        mediaType: "audio/mp4",
      }),
    ).resolves.toEqual({
      status: "refused",
      category: "unavailable",
      message: "Could not reach the computer to transcribe the recording.",
    });

    const forbidden = transportAnswering(() => new Response(null, { status: 403 }));
    await expect(
      transcribeMobileClip({ transport: forbidden.transport, audio: m4a, mediaType: "audio/mp4" }),
    ).resolves.toMatchObject({ status: "refused", category: "unavailable" });
  });
});
