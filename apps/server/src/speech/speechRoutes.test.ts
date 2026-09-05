import {
  decodeProviderInstance,
  decodeSpeechFailureResponse,
  decodeSpeechStatusResponse,
  decodeSpeechTranscript,
  type ProviderInstance,
  type VoiceSettings,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import type { SpeechAdapter } from "./speechAdapter";
import { createSpeechRouteHandler } from "./speechRoutes";

const nowMs = Date.parse("2026-09-05T10:00:00.000Z");
const now = "2026-09-05T10:00:00.000Z";
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const compatibleId = "00000000-0000-4000-8000-00000000c001";
const origin = "http://127.0.0.1:5173";

const wav = Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVEfmt ")]);

function compatible(enabled = true): ProviderInstance {
  return decodeProviderInstance({
    id: compatibleId,
    displayName: "OpenAI",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
    },
    enabled,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

const configured: VoiceSettings = {
  transcription: { providerInstanceId: compatibleId as never, modelId: "whisper-1" as never },
  synthesis: {
    providerInstanceId: compatibleId as never,
    modelId: "gpt-4o-mini-tts" as never,
    voice: "alloy" as never,
  },
};

function setup(
  options: {
    readonly settings?: VoiceSettings;
    readonly instances?: ReadonlyArray<ProviderInstance>;
    readonly adapter?: Partial<SpeechAdapter>;
  } = {},
) {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  const transcribe = vi.fn(
    options.adapter?.transcribe ?? (async () => ({ status: "completed" as const, text: "hi" })),
  );
  const synthesize = vi.fn(
    options.adapter?.synthesize ??
      (async () => ({
        status: "completed" as const,
        bytes: Uint8Array.from([9, 8, 7]),
        mediaType: "audio/mpeg",
      })),
  );
  const handler = createSpeechRouteHandler({
    readVoiceSettings: () => options.settings ?? configured,
    listInstances: () => options.instances ?? [compatible()],
    windowAuthorityStore,
    makeAdapter: () => ({ transcribe, synthesize }),
    now: () => nowMs,
  });
  return { handler, transcribe, synthesize };
}

function request(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: BodyInit;
    readonly headers?: Record<string, string>;
    readonly capability?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { origin, ...options.headers };
  if (options.capability !== "omit") {
    headers["x-octant-window-capability"] = options.capability ?? capability;
  }
  return new Request(`http://127.0.0.1:3100${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function clip(audio: Uint8Array = wav, language?: string): FormData {
  const form = new FormData();
  form.set("audio", new Blob([Uint8Array.from(audio)], { type: "audio/wav" }), "clip.wav");
  if (language !== undefined) form.set("language", language);
  return form;
}

describe("speech routes", () => {
  it("reports each direction's readiness with the Settings link that fixes it", async () => {
    const { handler } = setup({ settings: { transcription: configured.transcription } });
    const response = await handler(request("/api/speech/status"));
    expect(response?.status).toBe(200);
    const body = decodeSpeechStatusResponse(await response!.json());
    expect(body.transcription).toEqual({
      status: "ready",
      providerInstanceId: compatibleId,
      modelId: "whisper-1",
    });
    expect(body.synthesis).toEqual({
      status: "unconfigured",
      settingsTarget: { section: "voice", setting: "synthesis" },
    });
  });

  it("refuses every voice request without a live window capability", async () => {
    const { handler, transcribe } = setup();
    const response = await handler(
      request("/api/speech/transcriptions", {
        method: "POST",
        body: clip(),
        capability: "omit",
      }),
    );
    expect(response?.status).toBe(401);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("refuses transcription with a Settings link when the endpoint is unconfigured or gone", async () => {
    const unconfigured = setup({ settings: {} });
    const missing = await unconfigured.handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(missing?.status).toBe(412);
    expect(decodeSpeechFailureResponse(await missing!.json())).toEqual({
      error: "Transcription is not configured.",
      category: "unconfigured",
      settingsTarget: { section: "voice", setting: "transcription" },
    });

    const disabled = setup({ instances: [compatible(false)] });
    const off = await disabled.handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(off?.status).toBe(412);
    expect(decodeSpeechFailureResponse(await off!.json())).toMatchObject({
      error: "Transcription is unavailable: The chosen provider is disabled.",
      // A gone instance is not an empty setting, and a surface offers a
      // different next step for each.
      category: "unavailable",
    });
    expect(disabled.transcribe).not.toHaveBeenCalled();
  });

  it("reports a provider credential failure as a gateway error, not a window authority failure", async () => {
    const { handler } = setup({
      adapter: {
        transcribe: async () => ({
          status: "failed",
          providerFailure: {
            category: "unauthenticated",
            message: "The provider rejected the credential.",
          },
        }),
      },
    });
    const response = await handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    // 401 here would start local window-session renewal instead of surfacing
    // the speech error.
    expect(response?.status).toBe(502);
    expect(decodeSpeechFailureResponse(await response!.json()).category).toBe("unauthenticated");
  });

  it("transcribes a sniffed clip on the configured model and returns only the text", async () => {
    const { handler, transcribe } = setup();
    const response = await handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip(wav, "nb-NO") }),
    );
    expect(response?.status).toBe(200);
    expect(decodeSpeechTranscript(await response!.json())).toEqual({ text: "hi" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const call = transcribe.mock.calls[0]![0];
    expect(call.modelId).toBe("whisper-1");
    expect(call.mediaType).toBe("audio/wav");
    expect(call.language).toBe("nb-NO");
    expect([...call.audio]).toEqual([...wav]);
  });

  it("refuses a clip whose bytes are not audio, whatever the part claims", async () => {
    const { handler, transcribe } = setup();
    const response = await handler(
      request("/api/speech/transcriptions", {
        method: "POST",
        body: clip(Uint8Array.from(Buffer.from('{"text":"pretend audio"}'))),
      }),
    );
    expect(response?.status).toBe(400);
    expect(decodeSpeechFailureResponse(await response!.json()).error).toBe(
      "The recording is not a supported audio format.",
    );
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("surfaces a provider failure by category without the upstream body", async () => {
    const { handler } = setup({
      adapter: {
        transcribe: async () => ({
          status: "failed",
          providerFailure: {
            category: "rate-limited",
            message: "The provider rate limit was reached.",
            retryAfterMs: 5_000,
          },
        }),
      },
    });
    const response = await handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(response?.status).toBe(429);
    expect(decodeSpeechFailureResponse(await response!.json())).toEqual({
      error: "The provider rate limit was reached.",
      category: "rate-limited",
      retryAfterMs: 5_000,
    });
  });

  it("refuses a third concurrent clip instead of queueing it", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = setup({
      adapter: {
        transcribe: async () => {
          await blocked;
          return { status: "completed", text: "late" };
        },
      },
    });
    const first = handler(request("/api/speech/transcriptions", { method: "POST", body: clip() }));
    const second = handler(request("/api/speech/transcriptions", { method: "POST", body: clip() }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(third?.status).toBe(503);
    expect(decodeSpeechFailureResponse(await third!.json()).category).toBe("unavailable");
    release();
    expect((await first)?.status).toBe(200);
    expect((await second)?.status).toBe(200);
  });

  it("refuses an overflowing clip without buffering its body", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handler } = setup({
      adapter: {
        transcribe: async () => {
          await blocked;
          return { status: "completed", text: "late" };
        },
      },
    });
    const first = handler(request("/api/speech/transcriptions", { method: "POST", body: clip() }));
    const second = handler(request("/api/speech/transcriptions", { method: "POST", body: clip() }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overflow = request("/api/speech/transcriptions", { method: "POST", body: clip() });
    const third = await handler(overflow);

    expect(third?.status).toBe(503);
    // The gate is taken before the body is read, so an overflowing clip is
    // refused without its audio ever being held in memory.
    expect(overflow.bodyUsed).toBe(false);
    release();
    expect((await first)?.status).toBe(200);
    expect((await second)?.status).toBe(200);
  });

  it("returns synthesized audio bytes with the media type and no caching", async () => {
    const { handler, synthesize } = setup();
    const response = await handler(
      request("/api/speech/synthesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Read this aloud", format: "mp3" }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("audio/mpeg");
    expect(response?.headers.get("cache-control")).toContain("no-store");
    expect([...new Uint8Array(await response!.arrayBuffer())]).toEqual([9, 8, 7]);
    expect(synthesize.mock.calls[0]![0]).toMatchObject({
      text: "Read this aloud",
      modelId: "gpt-4o-mini-tts",
      voice: "alloy",
      format: "mp3",
    });
  });

  it("refuses synthesis of empty or overlong text before touching the provider", async () => {
    const { handler, synthesize } = setup();
    const empty = await handler(
      request("/api/speech/synthesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      }),
    );
    expect(empty?.status).toBe(400);
    const long = await handler(
      request("/api/speech/synthesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a".repeat(5_000) }),
      }),
    );
    expect(long?.status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });
});
