import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeOpenCode2Driver } from "./openCode2Driver";
import { normalizeOpenCode2Catalog } from "./openCode2Catalog";
import type { ModelV2Info, ProviderV2Info } from "@opencode-ai/sdk/v2/types";
import type { AcpProcessPort } from "./acpProcess";
import type { OpenCodeProcessPort } from "./openCodeProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000061");

describe("OpenCode 2 driver", () => {
  it("normalizes the beta v2 model catalog without claiming unsupported capabilities", () => {
    const providers: ReadonlyArray<ProviderV2Info> = [
      {
        id: "openai",
        name: "OpenAI",
        api: { type: "native", settings: {} },
        request: { headers: {}, body: {} },
      },
    ];
    const models: ReadonlyArray<ModelV2Info> = [
      {
        id: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        api: { id: "gpt-5", type: "native", settings: {} },
        capabilities: { tools: true, input: ["text", "image"], output: ["text", "reasoning"] },
        request: { headers: {}, body: {} },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 100_000, output: 8_000 },
      },
    ];
    const result = normalizeOpenCode2Catalog(
      instanceId,
      { version: "opencode2 v0.0.0-beta-18721" },
      providers,
      models,
      "2026-09-08T00:00:00.000Z",
    );

    expect(result.readiness).toBe("ready");
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      id: "openai/gpt-5",
      displayName: "GPT-5",
      inputModalities: ["text", "image"],
      reasoning: "supported",
      toolCalling: "supported",
      contextLimit: 100_000,
    });
    expect(result.capabilities).toMatchObject({
      approvals: "supported",
      userQuestions: "unsupported",
      appManagedTools: "unsupported",
      usage: "unavailable",
      fileChanges: "unavailable",
    });
  });

  it("uses the beta HTTP process only for provider catalog discovery", async () => {
    const catalogStart = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "catalog process selected" }),
    );
    const acpStart = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "ACP process selected" }),
    );
    const driver = makeOpenCode2Driver({
      instanceId,
      binaryPath: "/missing/opencode2",
      catalogProcess: { start: catalogStart } as unknown as OpenCodeProcessPort,
      acpProcess: { start: acpStart } as unknown as AcpProcessPort,
      acpHome: "/managed/opencode",
      runtimeRegistry: new ProviderRuntimeRegistry(),
      permissionPersistence: () => "current-session",
    });

    await expect(Effect.runPromise(Effect.scoped(driver.probe({ instanceId })))).rejects.toThrow(
      "catalog process selected",
    );
    expect(catalogStart).toHaveBeenCalledOnce();
    expect(acpStart).not.toHaveBeenCalled();
  });

  it("uses the ACP process for an acquired Code session", async () => {
    const catalogStart = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "catalog process selected" }),
    );
    const acpStart = vi.fn(() =>
      Effect.fail({ category: "unavailable" as const, message: "ACP process selected" }),
    );
    const driver = makeOpenCode2Driver({
      instanceId,
      binaryPath: "/missing/opencode2",
      catalogProcess: { start: catalogStart } as unknown as OpenCodeProcessPort,
      acpProcess: { start: acpStart } as unknown as AcpProcessPort,
      acpHome: "/managed/opencode",
      runtimeRegistry: new ProviderRuntimeRegistry(),
      permissionPersistence: () => "current-session",
    });

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* driver.acquire({
              instanceId,
              projectRoot: "/tmp",
              mode: "code",
            });
            yield* connection.start({
              sessionId: decodeProviderSessionId("80000000-0000-4000-8000-000000000062"),
              modelId: decodeProviderModelId("openai/gpt"),
              executionPolicy: "approval-gated",
            });
          }),
        ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("OpenCode 2 request failed") });
    expect(acpStart).toHaveBeenCalledOnce();
    expect(acpStart).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "code",
        profile: expect.objectContaining({ kind: "opencode" }),
      }),
    );
    expect(catalogStart).not.toHaveBeenCalled();
  });
});
