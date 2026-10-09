import { describe, expect, it } from "vitest";
import {
  MODEL_CONTEXT_PROFILES,
  findModelContextProfile,
  learnContextWindow,
  normalizeModelName,
  readReportedInputModalities,
  resolveModelContextWindow,
  resolveModelInputModalities,
} from "./modelContextWindow";

describe("model context window", () => {
  it("matches one model however a provider spells it", () => {
    for (const spelling of [
      "DeepSeek-V4.1-Flash",
      "deepseek_v4.1_flash",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      " deepseek v4.1 flash ",
    ]) {
      expect(normalizeModelName(spelling)).toBe("deepseek-v4-1-flash");
    }
    expect(normalizeModelName("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4-5");
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelName("gpt-4.1-2025-04-14")).toBe("gpt-4-1");
    expect(normalizeModelName("gpt-4o-latest")).toBe("gpt-4o");
    expect(normalizeModelName("llama3:latest")).toBe("llama3");
  });

  it("keeps a different version a different model", () => {
    expect(findModelContextProfile("gpt-4.1")?.contextWindow).toBe(1_047_576);
    expect(findModelContextProfile("gpt-4")).toBeUndefined();
    expect(findModelContextProfile("deepseek-v4-flash")).toBeUndefined();
  });

  it("names every profile once and only by its normalized name", () => {
    const names = MODEL_CONTEXT_PROFILES.flatMap((profile) => profile.names);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(normalizeModelName(name)).toBe(name);
    for (const profile of MODEL_CONTEXT_PROFILES) {
      expect(profile.maxOutput ?? 0).toBeLessThanOrEqual(profile.contextWindow);
    }
  });

  it("resolves a window from the most direct source that names one", () => {
    const facts = {
      id: "gpt-4.1",
      contextLimit: 900_000,
      learnedContextWindow: 950_000,
      contextWindowOverride: 500_000,
    };
    expect(resolveModelContextWindow(facts)).toMatchObject({
      contextWindow: 500_000,
      source: "user-supplied",
    });
    const { contextWindowOverride: _override, ...automatic } = facts;
    expect(resolveModelContextWindow(automatic)).toMatchObject({
      contextWindow: 900_000,
      source: "provider-discovery",
    });
    const { contextLimit: _reported, ...unreported } = automatic;
    expect(resolveModelContextWindow(unreported)).toMatchObject({
      contextWindow: 950_000,
      source: "observed-evidence",
    });
    const { learnedContextWindow: _learned, ...profiled } = unreported;
    expect(resolveModelContextWindow(profiled)).toEqual({
      contextWindow: 1_047_576,
      maxOutput: 32_768,
      source: "reviewed-catalog",
    });
    expect(resolveModelContextWindow({ id: "house-model" })).toBeUndefined();
  });

  it("believes a refusal below what the provider reported", () => {
    // The endpoint enforced a smaller window than its own metadata listed.
    expect(
      resolveModelContextWindow({
        id: "served",
        contextLimit: 128_000,
        learnedContextWindow: 64_000,
      }),
    ).toMatchObject({ contextWindow: 64_000, source: "observed-evidence" });
  });

  it("finds the profile of an Azure deployment with a name of its own through the model it served", () => {
    const deployment = { id: "team-chat-prod" };
    expect(resolveModelContextWindow(deployment)).toBeUndefined();
    expect(
      resolveModelContextWindow({ ...deployment, servedModelId: "DeepSeek-V4.1-Flash" }),
    ).toEqual({ contextWindow: 1_000_000, source: "reviewed-catalog" });
  });

  it("never gives a maximum output larger than the window it resolved", () => {
    expect(resolveModelContextWindow({ id: "gpt-4.1", contextWindowOverride: 16_000 })).toEqual({
      contextWindow: 16_000,
      source: "user-supplied",
    });
  });

  it("lowers a learned window on a refusal and raises it on a larger request that fit", () => {
    expect(learnContextWindow(undefined, { kind: "refused", contextWindow: 65_536 })).toBe(65_536);
    expect(learnContextWindow(131_072, { kind: "refused", contextWindow: 65_536 })).toBe(65_536);
    expect(learnContextWindow(65_536, { kind: "refused", contextWindow: 131_072 })).toBe(65_536);
    expect(learnContextWindow(65_536, { kind: "completed", usedTokens: 70_000 })).toBe(70_000);
    expect(learnContextWindow(65_536, { kind: "completed", usedTokens: 1_000 })).toBe(65_536);
    expect(
      learnContextWindow(undefined, { kind: "completed", usedTokens: 70_000 }),
    ).toBeUndefined();
  });

  it("says a model whose provider documents image input accepts images", () => {
    for (const id of ["gpt-4o-2024-08-06", "openai/gpt-5-mini", "claude-sonnet-4-5", "o3"]) {
      expect(resolveModelInputModalities({ id })).toEqual({
        inputModalities: ["text", "image"],
        imageInput: "supported",
      });
    }
  });

  it("keeps a profiled model its provider documents as text-only on text", () => {
    // o3-mini shares o3's window but its model page lists text input only.
    expect(findModelContextProfile("o3-mini")?.contextWindow).toBe(200_000);
    expect(resolveModelInputModalities({ id: "o3-mini" })).toEqual({ inputModalities: ["text"] });
  });

  it("lets the modalities a provider reports win over the profile", () => {
    expect(
      resolveModelInputModalities({ id: "gpt-4o", reportedInputModalities: ["text"] }),
    ).toEqual({ inputModalities: ["text"], imageInput: "unsupported" });
    expect(
      resolveModelInputModalities({
        id: "house-model",
        reportedInputModalities: ["image", "text"],
      }),
    ).toEqual({ inputModalities: ["text", "image"], imageInput: "supported" });
  });

  it("keeps an unknown model text-only without claiming it cannot read images", () => {
    expect(resolveModelInputModalities({ id: "house-model" })).toEqual({
      inputModalities: ["text"],
    });
    expect(
      resolveModelInputModalities({ id: "team-vision-prod", servedModelId: "gpt-4.1-mini" }),
    ).toEqual({ inputModalities: ["text", "image"], imageInput: "supported" });
  });

  it("reads only the modalities Octant knows from a provider's list", () => {
    expect(readReportedInputModalities(["image", "text", "file", "image"])).toEqual([
      "text",
      "image",
    ]);
    expect(readReportedInputModalities(["video"])).toBeUndefined();
    expect(readReportedInputModalities("text,image")).toBeUndefined();
    expect(readReportedInputModalities(undefined)).toBeUndefined();
  });
});
