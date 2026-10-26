import { decodeDesktopRecipe } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { DesktopProvider } from "./desktopProvider";
import {
  runDesktopProviderConformance,
  type DesktopProviderConformanceScenario,
} from "./desktopProviderConformance";
import { createFakeDesktopProvider } from "./fakeDesktopProvider";

const recipe = decodeDesktopRecipe({
  providerId: "fake-desktop",
  screen: { width: 1280, height: 800 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
});

const unsupportedCommand = { operation: "launch", appId: "org.example.app" } as const;

function honest(billed: boolean) {
  return (scenario: DesktopProviderConformanceScenario) =>
    createFakeDesktopProvider({
      billed,
      locality: billed ? "cloud" : "host-local",
      behaviour: {
        declineExtensions: scenario.providerDeclinesExtension,
        lingerAfterRelease: scenario.desktopOutlivesDestroy,
      },
    }).provider;
}

/** An honest driver with one promise broken. */
function broken(
  billed: boolean,
  breakIt: (provider: DesktopProvider) => Partial<DesktopProvider>,
): (scenario: DesktopProviderConformanceScenario) => DesktopProvider {
  return (scenario) => {
    const provider = honest(billed)(scenario);
    return { ...provider, ...breakIt(provider) };
  };
}

describe("desktop provider conformance", () => {
  it.each([false, true])(
    "passes an in-memory driver that keeps the seam (billed: %s)",
    async (billed) => {
      await expect(
        runDesktopProviderConformance({ create: honest(billed), recipe, unsupportedCommand }),
      ).resolves.toMatchObject({ stoppedWhenCancelled: true, reportedAbsenceOnlyWhenAbsent: true });
    },
  );

  it.each([
    [
      "a cancelled acquire did not stop",
      broken(false, (provider) => ({
        acquire: (request) =>
          provider.acquire({ ...request, signal: new AbortController().signal }),
      })),
    ],
    [
      "the desktop is not listed under its lease id and host tag",
      broken(false, () => ({
        listOwned: async () => ({ status: "listed", resources: [] }),
      })),
    ],
    [
      "a billed desktop has no provider-side expiry",
      (scenario: DesktopProviderConformanceScenario) =>
        createFakeDesktopProvider({
          billed: true,
          behaviour: {
            omitProviderExpiry: true,
            declineExtensions: scenario.providerDeclinesExtension,
          },
        }).provider,
    ],
    [
      "an extension the provider declined was reported as extended",
      broken(false, () => ({
        extend: async (_handle, expiresAt) => ({ status: "extended", expiresAt }),
      })),
    ],
    [
      "a desktop that outlived its destroy was reported gone",
      broken(false, () => ({ verifyGone: async () => ({ status: "gone" }) })),
    ],
    [
      "an unsupported command was not refused as unsupported",
      broken(false, () => ({ control: async () => ({ kind: "apps", apps: [] }) })),
    ],
    [
      "release threw instead of answering",
      broken(false, () => ({
        release: async () => {
          throw new Error("socket closed");
        },
      })),
    ],
  ])("refuses a driver when %s", async (message, create) => {
    await expect(
      runDesktopProviderConformance({ create, recipe, unsupportedCommand }),
    ).rejects.toThrow(message);
  });
});
