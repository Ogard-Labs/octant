import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  listImageSourceEligibleInstances,
  resolveImageCustomSource,
  resolveImageCustomSources,
} from "./imageSourcePolicy";

const now = "2026-09-05T10:00:00.000Z";
const compatibleId = "00000000-0000-4000-8000-00000000d001";
const disabledId = "00000000-0000-4000-8000-00000000d002";
const imageId = "00000000-0000-4000-8000-00000000d003";
const missingId = "00000000-0000-4000-8000-00000000dfff";

function compatible(id: string, enabled = true): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: enabled ? "Recraft" : "Groq (off)",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.recraft.ai/v1",
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

describe("image source policy", () => {
  it("offers only enabled OpenAI-compatible instances as a custom image source", () => {
    expect(
      listImageSourceEligibleInstances(instances).map((instance) => String(instance.id)),
    ).toEqual([compatibleId]);
  });

  it("resolves a configured source to the instance and model it names", () => {
    const resolution = resolveImageCustomSource(
      { providerInstanceId: compatibleId as never, modelId: "recraftv3" as never, label: "Recraft" },
      instances,
    );
    expect(resolution.status).toBe("ready");
    if (resolution.status !== "ready") throw new Error("expected ready");
    expect(String(resolution.instance.id)).toBe(compatibleId);
    expect(resolution.modelId).toBe("recraftv3");
    expect(resolution.label).toBe("Recraft");
  });

  it("never substitutes another instance when the chosen one cannot serve", () => {
    expect(
      resolveImageCustomSource(
        { providerInstanceId: disabledId as never, modelId: "recraftv3" as never, label: "Off" },
        instances,
      ),
    ).toEqual({ status: "unavailable", label: "Off", reason: "The chosen provider is disabled." });
    expect(
      resolveImageCustomSource(
        { providerInstanceId: imageId as never, modelId: "recraftv3" as never, label: "Wrong kind" },
        instances,
      ),
    ).toEqual({
      status: "unavailable",
      label: "Wrong kind",
      reason: "Image generation needs an OpenAI-compatible HTTP provider.",
    });
    expect(
      resolveImageCustomSource(
        { providerInstanceId: missingId as never, modelId: "recraftv3" as never, label: "Gone" },
        instances,
      ),
    ).toEqual({
      status: "unavailable",
      label: "Gone",
      reason: "The chosen provider no longer exists.",
    });
  });

  it("resolves every configured source in order", () => {
    const resolved = resolveImageCustomSources(
      [
        { providerInstanceId: compatibleId as never, modelId: "recraftv3" as never, label: "Ready" },
        { providerInstanceId: disabledId as never, modelId: "recraftv3" as never, label: "Off" },
      ],
      instances,
    );
    expect(resolved.map((resolution) => resolution.status)).toEqual(["ready", "unavailable"]);
  });
});
