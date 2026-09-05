import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  listSpeechEligibleInstances,
  resolveSpeechEndpoint,
  speechStatusOf,
  VOICE_SYNTHESIS_TARGET,
  VOICE_TRANSCRIPTION_TARGET,
} from "./speechPolicy";

const now = "2026-09-05T10:00:00.000Z";
const compatibleId = "00000000-0000-4000-8000-00000000c001";
const disabledId = "00000000-0000-4000-8000-00000000c002";
const imageId = "00000000-0000-4000-8000-00000000c003";

function compatible(id: string, enabled = true): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: enabled ? "OpenAI" : "Groq (off)",
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

function imageProfile(): ProviderInstance {
  return decodeProviderInstance({
    id: imageId,
    displayName: "OpenAI Image",
    driverKind: "openai-image",
    configuration: {
      kind: "openai-image-http",
      modelAllowlist: ["gpt-image-2"],
      defaultModel: "gpt-image-2",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

const instances = [compatible(compatibleId), compatible(disabledId, false), imageProfile()];

describe("speech endpoint policy", () => {
  it("offers only enabled OpenAI-compatible instances for voice", () => {
    expect(listSpeechEligibleInstances(instances).map((instance) => String(instance.id))).toEqual([
      compatibleId,
    ]);
  });

  it("resolves a configured endpoint to the instance and model it names", () => {
    const resolution = resolveSpeechEndpoint(
      { providerInstanceId: compatibleId as never, modelId: "whisper-1" as never },
      instances,
    );
    expect(resolution.status).toBe("ready");
    if (resolution.status !== "ready") throw new Error("expected ready");
    expect(String(resolution.instance.id)).toBe(compatibleId);
    expect(resolution.modelId).toBe("whisper-1");
    expect(resolution.voice).toBeUndefined();
  });

  it("never substitutes another instance when the chosen one cannot serve", () => {
    expect(resolveSpeechEndpoint(undefined, instances)).toEqual({ status: "unconfigured" });
    expect(
      resolveSpeechEndpoint(
        { providerInstanceId: disabledId as never, modelId: "whisper-1" as never },
        instances,
      ),
    ).toEqual({ status: "unavailable", reason: "The chosen provider is disabled." });
    expect(
      resolveSpeechEndpoint(
        { providerInstanceId: imageId as never, modelId: "whisper-1" as never },
        instances,
      ),
    ).toEqual({ status: "unavailable", reason: "Voice needs an OpenAI-compatible HTTP provider." });
    expect(
      resolveSpeechEndpoint(
        {
          providerInstanceId: "00000000-0000-4000-8000-00000000cfff" as never,
          modelId: "whisper-1" as never,
        },
        instances,
      ),
    ).toEqual({ status: "unavailable", reason: "The chosen provider no longer exists." });
  });

  it("reports each direction with the Settings link that fixes it", () => {
    const status = speechStatusOf(
      {
        synthesis: {
          providerInstanceId: compatibleId as never,
          modelId: "gpt-4o-mini-tts" as never,
          voice: "alloy" as never,
        },
      },
      instances,
    );
    expect(status.transcription).toEqual({
      status: "unconfigured",
      settingsTarget: VOICE_TRANSCRIPTION_TARGET,
    });
    expect(status.synthesis).toEqual({
      status: "ready",
      providerInstanceId: compatibleId,
      modelId: "gpt-4o-mini-tts",
      voice: "alloy",
    });
    expect(VOICE_SYNTHESIS_TARGET).toEqual({ section: "voice", setting: "synthesis" });
  });
});
