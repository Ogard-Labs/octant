import { describe, expect, it } from "vitest";
import { isSpeechUsable, voiceModelsOf } from "./voiceModels";

const ids = (...list: string[]) => list.map((id) => ({ id: id as never }));

describe("the voice models an endpoint offers", () => {
  it("takes a preset's hint when the endpoint lists that model, or lists nothing yet", () => {
    const hint = { transcription: "voxtral-mini-latest", speech: "voxtral-mini-tts-2603" };
    expect(
      voiceModelsOf(ids("mistral-small", "voxtral-mini-latest", "voxtral-mini-tts-2603"), hint),
    ).toEqual(hint);
    expect(voiceModelsOf([], hint)).toEqual(hint);
    expect(voiceModelsOf(undefined, hint)).toEqual(hint);
  });

  it("reads the model ids when there is no hint, and never names the same model twice", () => {
    expect(voiceModelsOf(ids("gpt-4.1", "whisper-1", "gpt-4o-mini-tts"))).toEqual({
      transcription: "whisper-1",
      speech: "gpt-4o-mini-tts",
    });
    expect(voiceModelsOf(ids("llama-3", "qwen-coder"))).toEqual({});
    expect(voiceModelsOf(ids("voxtral-small-latest"))).toEqual({
      transcription: "voxtral-small-latest",
    });
  });

  it("falls back to the listed ids when the hinted model is not served", () => {
    expect(voiceModelsOf(ids("whisper-large"), { transcription: "voxtral-mini-latest" })).toEqual({
      transcription: "whisper-large",
    });
  });
});

describe("which endpoints Voice can use", () => {
  const instance = (driverKind: string, enabled: boolean) =>
    ({ driverKind, enabled }) as unknown as Parameters<typeof isSpeechUsable>[0];

  it("accepts only an enabled OpenAI-compatible endpoint", () => {
    expect(isSpeechUsable(instance("openai-compatible", true))).toBe(true);
    expect(isSpeechUsable(instance("openai-compatible", false))).toBe(false);
    expect(isSpeechUsable(instance("ollama", true))).toBe(false);
    expect(isSpeechUsable(instance("azure-foundry", true))).toBe(false);
    expect(isSpeechUsable(instance("anthropic-compatible", true))).toBe(false);
  });
});
