import { describe, expect, it } from "vitest";
import {
  decodeSpeechCapabilityStatus,
  decodeSpeechFailureResponse,
  decodeSpeechSynthesisRequest,
  decodeSpeechTranscript,
  decodeSpeechTranscriptionLanguage,
  decodeVoiceSettings,
  SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS,
} from "./speech";

const endpoint = {
  providerInstanceId: "00000000-0000-4000-8000-00000000c001",
  modelId: "whisper-1",
} as const;

describe("VoiceSettings", () => {
  it("decodes the empty section with both directions absent", () => {
    const settings = decodeVoiceSettings({});
    expect(settings.transcription).toBeUndefined();
    expect(settings.synthesis).toBeUndefined();
  });

  it("requires a voice for synthesis but not for transcription", () => {
    expect(
      decodeVoiceSettings({
        transcription: endpoint,
        synthesis: { ...endpoint, modelId: "gpt-4o-mini-tts", voice: "alloy" },
      }).synthesis?.voice,
    ).toBe("alloy");
    expect(() => decodeVoiceSettings({ synthesis: endpoint })).toThrow();
    expect(() => decodeVoiceSettings({ transcription: { ...endpoint, voice: "alloy" } })).toThrow();
    expect(() => decodeVoiceSettings({ transcription: { modelId: "whisper-1" } })).toThrow();
    expect(() => decodeVoiceSettings({ fallback: "system" })).toThrow();
  });
});

describe("speech requests and responses", () => {
  it("accepts a silent clip's empty transcript and bounds spoken text", () => {
    expect(decodeSpeechTranscript({ text: "" }).text).toBe("");
    expect(decodeSpeechSynthesisRequest({ text: "Hello there" }).format).toBeUndefined();
    expect(decodeSpeechSynthesisRequest({ text: "Hello", format: "wav" }).format).toBe("wav");
    expect(() => decodeSpeechSynthesisRequest({ text: "   " })).toThrow();
    expect(() =>
      decodeSpeechSynthesisRequest({ text: "a".repeat(SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS + 1) }),
    ).toThrow();
    expect(() => decodeSpeechSynthesisRequest({ text: "Hello", format: "aac" })).toThrow();
  });

  it("accepts BCP-47-shaped language hints and rejects free text", () => {
    expect(decodeSpeechTranscriptionLanguage("en")).toBe("en");
    expect(decodeSpeechTranscriptionLanguage("nb-NO")).toBe("nb-NO");
    expect(() => decodeSpeechTranscriptionLanguage("english please")).toThrow();
  });

  it("carries the Settings destination on every non-ready status and refusal", () => {
    const target = { section: "voice", setting: "transcription" } as const;
    expect(decodeSpeechCapabilityStatus({ status: "ready", ...endpoint }).status).toBe("ready");
    expect(
      decodeSpeechCapabilityStatus({ status: "unconfigured", settingsTarget: target }).status,
    ).toBe("unconfigured");
    expect(() => decodeSpeechCapabilityStatus({ status: "unconfigured" })).toThrow();
    expect(() =>
      decodeSpeechCapabilityStatus({ status: "unavailable", settingsTarget: target }),
    ).toThrow();
    expect(
      decodeSpeechFailureResponse({
        error: "Voice transcription is not configured.",
        category: "unconfigured",
        settingsTarget: target,
      }).category,
    ).toBe("unconfigured");
    expect(
      decodeSpeechFailureResponse({ error: "Rate limited.", category: "rate-limited" }).category,
    ).toBe("rate-limited");
    expect(() => decodeSpeechFailureResponse({ error: "x", category: "busy" })).toThrow();
  });
});
