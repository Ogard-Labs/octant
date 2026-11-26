import {
  decodeProviderInstance,
  decodeSpeechFailureResponse,
  decodeSpeechLocalEngineStatus,
  decodeSpeechStatusResponse,
  SPEECH_LOCAL_MAX_PCM_BYTES,
  decodeSpeechTranscript,
  type ProviderInstance,
  type VoiceSettings,
} from "@octant/contracts";
import { LOCAL_SPEECH_PAIRED_REASON, REMOTE_TRANSCRIPTION_BUDGET } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import type { AppleSpeechEngine } from "./appleSpeechEngine";
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

import { createSpeechGates } from "./speechGates";

function fakeEngine(engine: Partial<AppleSpeechEngine>): AppleSpeechEngine {
  return {
    status: async () => ({ status: "ready", language: "nb-NO" as never }),
    download: async () => ({ status: "downloading", language: "nb-NO" as never, fraction: 0 }),
    transcribe: async () => ({ status: "completed", text: "hei" }),
    dispose: () => undefined,
    ...engine,
  };
}

function setup(
  options: {
    readonly settings?: VoiceSettings;
    readonly instances?: ReadonlyArray<ProviderInstance>;
    readonly adapter?: Partial<SpeechAdapter>;
    readonly now?: () => number;
    readonly engine?: Partial<AppleSpeechEngine>;
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
  const gates = createSpeechGates();
  const handler = createSpeechRouteHandler({
    gates,
    readVoiceSettings: () => options.settings ?? configured,
    listInstances: () => options.instances ?? [compatible()],
    windowAuthorityStore,
    makeAdapter: () => ({ transcribe, synthesize }),
    ...(options.engine === undefined ? {} : { localEngine: fakeEngine(options.engine) }),
    now: options.now ?? (() => nowMs),
  });
  return { handler, transcribe, synthesize, gates };
}

it("reserves a dictation slot even while an agent is transcribing", async () => {
  const { handler, gates } = setup();
  const agent = gates.transcription.tryAcquire("shared");
  expect(agent).toBeTypeOf("function");
  expect(gates.transcription.tryAcquire("shared")).toBeNull();
  const local = gates.transcription.tryAcquire("local");
  const dictate = () =>
    handler(request("/api/speech/transcriptions", { method: "POST", body: clip() }));
  expect((await dictate())?.status).toBe(503);
  local?.();
  expect((await dictate())?.status).toBe(200);
  agent?.();
});

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

const pairedDeviceId = "55000000-0000-4000-8000-000000000001";
const otherDeviceId = "55000000-0000-4000-8000-000000000002";

/**
 * The request a paired device's clip becomes after the private listener has
 * authenticated it: loopback-shaped, with the device bound as the principal
 * and no window capability.
 */
function pairedRequest(
  path: string,
  options: {
    readonly method?: string;
    readonly body?: BodyInit;
    readonly headers?: Record<string, string>;
    readonly deviceId?: string;
  } = {},
): Request {
  const deviceId = options.deviceId ?? pairedDeviceId;
  const remote = new Request(`http://127.0.0.1${path}`, {
    method: options.method ?? "GET",
    headers: { origin: "http://127.0.0.1", ...options.headers },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  bindPrincipalRouteContext(remote, {
    principal: {
      kind: "remote-device",
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "55000000-0000-4000-8000-0000000000aa",
    } as never,
    scopeId: deviceId as never,
  });
  return remote;
}

describe("speech routes for a paired device", () => {
  it("reports transcription readiness and keeps read-aloud on the computer", async () => {
    const { handler } = setup();
    const response = await handler(pairedRequest("/api/speech/status"));
    expect(response?.status).toBe(200);
    expect(decodeSpeechStatusResponse(await response!.json())).toEqual({
      transcription: { status: "ready", providerInstanceId: compatibleId, modelId: "whisper-1" },
      synthesis: {
        status: "unavailable",
        reason: "Read-aloud is available only on the computer itself.",
        settingsTarget: { section: "voice", setting: "synthesis" },
      },
    });
  });

  it("transcribes a sniffed clip on the host's endpoint and returns only the text, uncached", async () => {
    const { handler, transcribe } = setup();
    const response = await handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, max-age=0, no-store");
    expect(decodeSpeechTranscript(await response!.json())).toEqual({ text: "hi" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]![0].mediaType).toBe("audio/wav");

    const notAudio = await handler(
      pairedRequest("/api/speech/transcriptions", {
        method: "POST",
        body: clip(Uint8Array.from(Buffer.from('{"text":"pretend audio"}'))),
      }),
    );
    expect(notAudio?.status).toBe(400);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("refuses a clip while transcription is unconfigured or unavailable", async () => {
    const unconfigured = setup({ settings: {} });
    const refused = await unconfigured.handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(refused?.status).toBe(412);
    expect(decodeSpeechFailureResponse(await refused!.json()).category).toBe("unconfigured");

    const disabled = setup({ instances: [compatible(false)] });
    const unavailable = await disabled.handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(unavailable?.status).toBe(412);
    expect(decodeSpeechFailureResponse(await unavailable!.json()).category).toBe("unavailable");
    expect(unconfigured.transcribe).not.toHaveBeenCalled();
    expect(disabled.transcribe).not.toHaveBeenCalled();
  });

  it("refuses read-aloud even when synthesis is configured", async () => {
    const { handler, synthesize } = setup();
    const response = await handler(
      pairedRequest("/api/speech/synthesis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Read this aloud" }),
      }),
    );
    expect(response?.status).toBe(403);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("refuses a clip larger than a phone clip may be", async () => {
    const { handler, transcribe } = setup();
    const large = new Uint8Array(1_000_001);
    large.set(wav);
    const response = await handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip(large) }),
    );
    expect(response?.status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("holds each device to its own budget and leaves the computer's own dictation alone", async () => {
    let clock = nowMs;
    const { handler, transcribe } = setup({ now: () => clock });
    for (let index = 0; index < REMOTE_TRANSCRIPTION_BUDGET.maximum; index += 1) {
      const admitted = await handler(
        pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
      );
      expect(admitted?.status).toBe(200);
      clock += 1_000;
    }
    const overBudget = pairedRequest("/api/speech/transcriptions", {
      method: "POST",
      body: clip(),
    });
    const refused = await handler(overBudget);
    expect(refused?.status).toBe(429);
    expect(decodeSpeechFailureResponse(await refused!.json())).toEqual({
      error: "This device has used its voice allowance for now. Try again later.",
      category: "rate-limited",
      retryAfterMs:
        REMOTE_TRANSCRIPTION_BUDGET.windowMs - REMOTE_TRANSCRIPTION_BUDGET.maximum * 1_000,
    });
    // Refused before the route parses the clip. The listener has already read
    // the bytes in memory to check the device proof; nothing reaches disk.
    expect(overBudget.bodyUsed).toBe(false);
    expect(transcribe).toHaveBeenCalledTimes(REMOTE_TRANSCRIPTION_BUDGET.maximum);

    const otherDevice = await handler(
      pairedRequest("/api/speech/transcriptions", {
        method: "POST",
        body: clip(),
        deviceId: otherDeviceId,
      }),
    );
    expect(otherDevice?.status).toBe(200);
    const computer = await handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(computer?.status).toBe(200);

    clock = nowMs + REMOTE_TRANSCRIPTION_BUDGET.windowMs;
    const afterWindow = await handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(afterWindow?.status).toBe(200);
  });

  it("transcribes one clip at a time per device, so one phone cannot hold every host slot", async () => {
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
    const first = handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    expect(second?.status).toBe(503);
    expect(decodeSpeechFailureResponse(await second!.json()).category).toBe("unavailable");
    release();
    expect((await first)?.status).toBe(200);
  });

  it("keeps a slot for the computer's own dictation while paired devices are mid-clip", async () => {
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
    const first = handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const otherDeviceClip = pairedRequest("/api/speech/transcriptions", {
      method: "POST",
      body: clip(),
      deviceId: otherDeviceId,
    });
    const otherDevice = handler(otherDeviceClip);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const computer = handler(
      request("/api/speech/transcriptions", { method: "POST", body: clip() }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect((await first)?.status).toBe(200);
    expect((await computer)?.status).toBe(200);
    const refused = await otherDevice;
    expect(refused?.status).toBe(503);
    expect(decodeSpeechFailureResponse(await refused!.json()).category).toBe("unavailable");
    expect(otherDeviceClip.bodyUsed).toBe(false);

    // The busy refusal spent none of the other device's budget.
    for (let index = 0; index < REMOTE_TRANSCRIPTION_BUDGET.maximum; index += 1) {
      const admitted = await handler(
        pairedRequest("/api/speech/transcriptions", {
          method: "POST",
          body: clip(),
          deviceId: otherDeviceId,
        }),
      );
      expect(admitted?.status).toBe(200);
    }
  });
});

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

const local: VoiceSettings = { ...configured, transcriptionEngine: "apple-speech" };

/** The clip a window makes for the on-device engine: 16 kHz mono 16-bit PCM. */
function pcmClip(pcm: Uint8Array): Uint8Array {
  const bytes = Buffer.alloc(44 + pcm.byteLength);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + pcm.byteLength, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(pcm.byteLength, 40);
  bytes.set(pcm, 44);
  return bytes;
}

describe("on-device transcription", () => {
  const pcm = Uint8Array.from([1, 2, 3, 4]);
  const dictate = (handler: ReturnType<typeof setup>["handler"], body: FormData) =>
    handler(request("/api/speech/transcriptions", { method: "POST", body }));

  it("turns a dictation into text on this computer without calling the saved endpoint", async () => {
    const asked = vi.fn<AppleSpeechEngine["transcribe"]>(async () => ({
      status: "completed",
      text: "hei fra mac",
    }));
    const { handler, transcribe } = setup({
      settings: {
        ...local,
        language: "no",
        dictionary: ["Octant" as never, "worktree" as never],
      },
      engine: { transcribe: asked },
    });

    const response = await dictate(handler, clip(pcmClip(pcm)));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toContain("no-store");
    expect(decodeSpeechTranscript(await response?.json())).toEqual({ text: "hei fra mac" });
    expect(asked).toHaveBeenCalledWith(
      expect.objectContaining({ language: "no", dictionary: ["Octant", "worktree"] }),
    );
    expect([...(asked.mock.calls[0]?.[0].pcm ?? [])]).toEqual([...pcm]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("lets a language the request names win over the setting", async () => {
    const asked = vi.fn<AppleSpeechEngine["transcribe"]>(async () => ({
      status: "completed",
      text: "",
    }));
    const { handler } = setup({
      settings: { ...local, language: "no" },
      engine: { transcribe: asked },
    });
    expect((await dictate(handler, clip(pcmClip(pcm), "en-GB")))?.status).toBe(200);
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ language: "en-GB" }));
  });

  it("never falls back to the endpoint when the engine is missing, not ready or fails", async () => {
    for (const engine of [
      undefined,
      {
        transcribe: async () => ({
          status: "unavailable" as const,
          engine: { status: "not-downloaded" as const, language: "nb-NO" as never },
        }),
      },
      {
        transcribe: async () => ({
          status: "failed" as const,
          providerFailure: { category: "provider-failed" as const, message: "It stopped." },
        }),
      },
    ]) {
      const { handler, transcribe } = setup({
        settings: local,
        ...(engine === undefined ? {} : { engine }),
      });
      const response = await dictate(handler, clip(pcmClip(pcm)));
      expect(response?.ok).toBe(false);
      decodeSpeechFailureResponse(await response?.json());
      expect(transcribe).not.toHaveBeenCalled();
    }
  });

  it("names Voice settings when the model is not on this Mac", async () => {
    const { handler } = setup({
      settings: local,
      engine: {
        transcribe: async () => ({
          status: "unavailable",
          engine: { status: "not-downloaded", language: "nb-NO" as never },
        }),
      },
    });
    const response = await dictate(handler, clip(pcmClip(pcm)));
    expect(response?.status).toBe(412);
    expect(decodeSpeechFailureResponse(await response?.json())).toEqual({
      error:
        "Apple's speech model for this language is not on this Mac. Download it in Voice settings.",
      category: "unavailable",
      settingsTarget: { section: "voice", setting: "transcription" },
    });
  });

  it("refuses a clip in another shape, an empty one and one past two minutes before native code sees it", async () => {
    const asked = vi.fn<AppleSpeechEngine["transcribe"]>(async () => ({
      status: "completed",
      text: "",
    }));
    const { handler } = setup({ settings: local, engine: { transcribe: asked } });
    const stereo = pcmClip(pcm);
    stereo[22] = 2;
    const lying = pcmClip(pcm);
    lying[40] = 200;
    for (const [audio, status] of [
      [wav, 400],
      [stereo, 400],
      [lying, 400],
      [pcmClip(new Uint8Array(0)), 400],
      [pcmClip(new Uint8Array(3)), 400],
      [pcmClip(new Uint8Array(SPEECH_LOCAL_MAX_PCM_BYTES + 2)), 413],
    ] as const) {
      expect((await dictate(handler, clip(audio)))?.status).toBe(status);
    }
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses a paired device and tells it dictation is unavailable", async () => {
    const asked = vi.fn<AppleSpeechEngine["transcribe"]>();
    const { handler, transcribe } = setup({ settings: local, engine: { transcribe: asked } });
    const status = decodeSpeechStatusResponse(
      await (await handler(pairedRequest("/api/speech/status")))?.json(),
    );
    expect(status.transcription).toMatchObject({
      status: "unavailable",
      reason: LOCAL_SPEECH_PAIRED_REASON,
    });
    const sent = await handler(
      pairedRequest("/api/speech/transcriptions", { method: "POST", body: clip(pcmClip(pcm)) }),
    );
    expect(sent?.status).toBe(412);
    for (const method of ["GET", "POST"]) {
      expect((await handler(pairedRequest("/api/speech/local-engine", { method })))?.status).toBe(
        403,
      );
    }
    expect(asked).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("reports the engine in the status a window reads", async () => {
    const asked = vi.fn<AppleSpeechEngine["status"]>(async () => ({
      status: "ready",
      language: "nb-NO" as never,
    }));
    const { handler } = setup({
      settings: { ...local, language: "no" },
      engine: { status: asked },
    });
    const status = decodeSpeechStatusResponse(
      await (await handler(request("/api/speech/status")))?.json(),
    );
    expect(status.transcription).toEqual({ status: "ready", engine: "apple-speech" });
    expect(asked).toHaveBeenCalledWith("no");
  });

  it("does not ask the engine about itself while an endpoint transcribes", async () => {
    const asked = vi.fn<AppleSpeechEngine["status"]>();
    const { handler } = setup({ engine: { status: asked } });
    expect((await handler(request("/api/speech/status")))?.status).toBe(200);
    expect(asked).not.toHaveBeenCalled();
  });

  it("fetches the model only when a window asks for it", async () => {
    const download = vi.fn<AppleSpeechEngine["download"]>(async () => ({
      status: "downloading",
      language: "nb-NO" as never,
      fraction: 0,
    }));
    const { handler } = setup({
      settings: local,
      engine: {
        status: async () => ({ status: "not-downloaded", language: "nb-NO" as never }),
        download,
      },
    });
    const seen = await handler(request("/api/speech/local-engine?language=no"));
    expect(decodeSpeechLocalEngineStatus(await seen?.json())).toEqual({
      status: "not-downloaded",
      language: "nb-NO",
    });
    await dictate(handler, clip(pcmClip(pcm)));
    expect(download).not.toHaveBeenCalled();
    const started = await handler(
      request("/api/speech/local-engine?language=no", { method: "POST" }),
    );
    expect(started?.status).toBe(202);
    expect(decodeSpeechLocalEngineStatus(await started?.json()).status).toBe("downloading");
    expect(download).toHaveBeenCalledWith("no");
    const wrong = await handler(
      request("/api/speech/local-engine?language=not%20a%20tag", { method: "POST" }),
    );
    expect(wrong?.status).toBe(400);
    expect(download).toHaveBeenCalledOnce();
  });

  it("refuses the engine's state to a request without window authority", async () => {
    const { handler } = setup({ settings: local, engine: {} });
    const response = await handler(
      request("/api/speech/local-engine", { method: "POST", capability: "omit" }),
    );
    expect(response?.status).toBe(401);
  });

  it("says a host without the engine cannot use it", async () => {
    const { handler } = setup();
    const seen = await handler(request("/api/speech/local-engine"));
    expect(decodeSpeechLocalEngineStatus(await seen?.json()).status).toBe("unsupported");
  });

  it("holds an on-device dictation to the same two at a time", async () => {
    const { handler, gates } = setup({ settings: local, engine: {} });
    const first = gates.transcription.tryAcquire("local");
    const second = gates.transcription.tryAcquire("local");
    expect((await dictate(handler, clip(pcmClip(pcm))))?.status).toBe(503);
    first?.();
    expect((await dictate(handler, clip(pcmClip(pcm))))?.status).toBe(200);
    second?.();
  });
});
