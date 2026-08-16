import { describe, expect, it } from "vitest";
import {
  hasSelectableProviderModels,
  listAutoProbeInstanceIds,
  shouldRunProviderBootstrap,
} from "./providerBootstrapPolicy";
import type { ProviderInstance } from "@octant/contracts";
import { decodeProviderInstanceId } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";

const ollamaId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000901");
const codexId = decodeProviderInstanceId("00000000-0000-4000-8000-000000000902");

function instance(
  id: typeof ollamaId,
  driverKind: ProviderInstance["driverKind"],
  enabled: boolean,
): ProviderInstance {
  return {
    id,
    driverKind,
    displayName: driverKind,
    enabled,
    version: 1,
    configuration:
      driverKind === "ollama"
        ? { kind: "ollama", baseUrl: "http://127.0.0.1:11434" }
        : { kind: "codex-cli", binaryPath: "/usr/local/bin/codex" },
    createdAt: "2026-07-26T20:00:00.000Z",
    updatedAt: "2026-07-26T20:00:00.000Z",
  } as ProviderInstance;
}

describe("providerBootstrapPolicy", () => {
  it("runs bootstrap only when providers are ready but no models are selectable", () => {
    expect(
      shouldRunProviderBootstrap({
        enabled: true,
        providerStatus: "ready",
        scanning: false,
        attempted: false,
        hasSelectableModels: false,
      }),
    ).toBe(true);
    expect(
      shouldRunProviderBootstrap({
        enabled: true,
        providerStatus: "ready",
        scanning: true,
        attempted: false,
        hasSelectableModels: false,
      }),
    ).toBe(false);
    expect(
      shouldRunProviderBootstrap({
        enabled: true,
        providerStatus: "ready",
        scanning: false,
        attempted: true,
        hasSelectableModels: false,
      }),
    ).toBe(false);
    expect(
      shouldRunProviderBootstrap({
        enabled: false,
        providerStatus: "ready",
        scanning: false,
        attempted: false,
        hasSelectableModels: false,
      }),
    ).toBe(false);
  });

  it("probes an enabled provider whose runtime observation was lost after restart", () => {
    const selected = listAutoProbeInstanceIds(
      [instance(codexId, "codex", true), instance(ollamaId, "ollama", true)],
      new Set([ollamaId]),
    );
    expect(selected).toEqual([codexId]);
  });

  it("detects selectable provider models from picker groups", () => {
    const empty: ReadonlyArray<PickerGroup> = [];
    const withModels = [
      {
        instance: instance(ollamaId, "ollama", true),
        readiness: "ready",
        driverLabel: "Ollama",
        endpointHost: undefined,
        executionHost: "local",
        sections: [
          {
            id: "default",
            label: "Default",
            models: [{ model: { id: "m", displayName: "M" } }],
          },
        ],
      },
    ] as unknown as ReadonlyArray<PickerGroup>;
    expect(hasSelectableProviderModels(empty)).toBe(false);
    expect(hasSelectableProviderModels(withModels)).toBe(true);
  });
});
