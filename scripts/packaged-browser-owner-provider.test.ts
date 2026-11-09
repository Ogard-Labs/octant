import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts";
import { makeOpenAiCompatibleDriver } from "../apps/server/src/providers/openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "../apps/server/src/providers/providerRuntimeRegistry";
import {
  OWNED_BROWSER_FIXTURE_MODEL,
  startOwnedBrowserProvider,
} from "./packaged-browser-owner-provider";

describe("the owned native Browser provider fixture", () => {
  it("passes the real no-auth Verify tools probe through automatic protocol fallback", async () => {
    const owner = new AbortController();
    const fixture = await startOwnedBrowserProvider({ signal: owner.signal, lifetimeMs: 10_000 });
    try {
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000901");
      const modelId = decodeProviderModelId(OWNED_BROWSER_FIXTURE_MODEL);
      const driver = makeOpenAiCompatibleDriver({
        instanceId,
        configuration: {
          kind: "openai-compatible-http",
          baseUrl: fixture.baseUrl,
          authentication: "none",
          protocol: "auto",
          manualModelIds: [],
        },
        runtimeRegistry: new ProviderRuntimeRegistry(),
        credentialResolver: {
          has: async () => false,
          resolve: async () => {
            throw Error("No credential may be requested.");
          },
        },
      });
      const probe = await Effect.runPromise(driver.probe({ instanceId }));
      expect(probe.models.some((model) => String(model.id) === String(modelId))).toBe(true);
      if (driver.verifyToolCapability === undefined) throw Error("No real tool verification port.");
      expect(
        await Effect.runPromise(driver.verifyToolCapability({ instanceId, modelId })),
      ).toMatchObject({ appManagedTools: "supported" });
      expect(fixture.evidence()).toMatchObject({
        models: 1,
        responsesRefused: 1,
        chatProbes: 1,
        rejected: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  it("refuses authentication and unknown paths and closes its owned listener on abort", async () => {
    const owner = new AbortController();
    const fixture = await startOwnedBrowserProvider({ signal: owner.signal, lifetimeMs: 10_000 });
    try {
      expect(
        (
          await fetch(`${fixture.baseUrl}/models`, {
            headers: { authorization: "synthetic-refused" },
          })
        ).status,
      ).toBe(400);
      expect((await fetch(`${fixture.baseUrl}/unknown`)).status).toBe(404);
      owner.abort();
      await fixture.close();
      await expect(fetch(`${fixture.baseUrl}/models`)).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });
});
