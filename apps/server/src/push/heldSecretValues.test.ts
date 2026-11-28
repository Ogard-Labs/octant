import { describe, expect, it, vi } from "vitest";
import { holdSecretValue, noteIssuedSecret } from "../process/secretRedaction";
import { createHeldSecretValuesReader } from "./heldSecretValues";

describe("host-side held secret value reader", () => {
  it("collects active in-memory secrets, ended held secrets, remembered pasted secrets, and stored broker credentials while skipping linked 1Password items", async () => {
    const activeSecret = "active-held-canary-901234";
    const endedSecret = "ended-held-canary-890123";
    const issuedSecret = "issued-oauth-canary-789012";
    const pastedSecret = "remembered-pasted-canary-678901";
    const storedProviderSecret = "stored-provider-canary-567890";

    const releaseEnded = holdSecretValue(endedSecret);
    releaseEnded();
    const releaseActive = holdSecretValue(activeSecret);
    noteIssuedSecret(issuedSecret);

    try {
      const resolveProvider = vi.fn(async (id: string) => {
        if (id === "prov-stored") return storedProviderSecret;
        throw new Error(`should never resolve ${id}`);
      });
      const reader = createHeldSecretValuesReader({
        namespaces: [
          {
            listIds: () => ["prov-stored", "prov-linked", "prov-missing"],
            referenceStatus: async (id) => (id === "prov-linked" ? "linked" : "none"),
            store: {
              has: async (id) => id === "prov-stored",
              resolve: resolveProvider,
            },
          },
        ],
        rememberedThreadSecrets: {
          listPasted: () => [{ id: "sec-1", name: "DEPLOY_TOKEN" }],
          resolvePasted: async () => ({ status: "found", value: pastedSecret }),
        },
      });

      const snapshot = await reader.read();
      expect(snapshot.status).toBe("ready");
      if (snapshot.status === "ready") {
        expect(snapshot.values).toContain(activeSecret);
        expect(snapshot.values).toContain(endedSecret);
        expect(snapshot.values).toContain(issuedSecret);
        expect(snapshot.values).toContain(pastedSecret);
        expect(snapshot.values).toContain(storedProviderSecret);
      }
      // Linked 1Password items are never read.
      expect(resolveProvider).toHaveBeenCalledTimes(1);
      expect(resolveProvider).toHaveBeenCalledWith("prov-stored");

      // Second read uses cached stored credentials without re-reading the broker.
      await reader.read();
      expect(resolveProvider).toHaveBeenCalledTimes(1);
    } finally {
      releaseActive();
    }
  });

  it("fails closed to unavailable when the credential store is locked or throws", async () => {
    const locked = createHeldSecretValuesReader({
      namespaces: [
        {
          listIds: () => ["prov-1"],
          store: {
            has: async () => {
              throw new Error("keychain locked");
            },
            resolve: async () => {
              throw new Error("keychain locked");
            },
          },
        },
      ],
    });
    expect(await locked.read()).toEqual({ status: "unavailable" });

    const brokenRemembered = createHeldSecretValuesReader({
      namespaces: [],
      rememberedThreadSecrets: {
        listPasted: () => [{ id: "sec-1", name: "TOKEN" }],
        resolvePasted: async () => ({ status: "unavailable" }),
      },
    });
    expect(await brokenRemembered.read()).toEqual({ status: "unavailable" });
  });
});
