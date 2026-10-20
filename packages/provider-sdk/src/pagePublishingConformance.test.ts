import { decodeProviderInstanceId, type PagePublishOutcome } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { ProviderPagePublishingSource } from "./pagePublishing";
import { runPagePublishingConformance } from "./pagePublishingConformance";

const signedIn = decodeProviderInstanceId("00000000-0000-4000-8000-000000000001");
const signedOut = decodeProviderInstanceId("00000000-0000-4000-8000-000000000002");
const request = { fileName: "launch-plan.html", title: "Launch plan", html: "<p>Plan</p>" };
const refusedRequest = { fileName: "too-big.html", title: "Too big", html: "<p>Nope</p>" };

/** A driver written only against the seam, with the account facts in memory. */
function honestSource(): ProviderPagePublishingSource {
  return {
    availability: ({ instanceId }) => {
      if (String(instanceId) === String(signedIn)) return { kind: "ready", account: "Work" };
      if (String(instanceId) === String(signedOut)) return { kind: "not-signed-in" };
      return { kind: "absent" };
    },
    publish: async (input): Promise<PagePublishOutcome> => {
      if (String(input.instanceId) === String(signedOut)) return { kind: "not-signed-in" };
      if (String(input.instanceId) !== String(signedIn)) {
        return { kind: "unavailable", message: "No such provider." };
      }
      if (input.fileName === refusedRequest.fileName) {
        return { kind: "refused", message: "The provider refused this page." };
      }
      return { kind: "published", address: "https://pages.example/p/launch-plan" };
    },
  };
}

function fixture(source: ProviderPagePublishingSource) {
  return {
    source,
    signedInInstanceId: signedIn,
    signedOutInstanceId: signedOut,
    request,
    refusedRequest,
  };
}

describe("page publishing conformance", () => {
  it("passes a driver that answers every case as a value", async () => {
    await expect(runPagePublishingConformance(fixture(honestSource()))).resolves.toEqual({
      signedOutPublishesNothing: true,
      unknownInstanceAbsent: true,
      readyNamesAccount: true,
      publishedNamesAddress: true,
      refusalIsValue: true,
    });
  });

  it("fails a driver that reports a page as published without an address", async () => {
    const honest = honestSource();
    const source: ProviderPagePublishingSource = {
      ...honest,
      publish: async (input) => {
        const outcome = await honest.publish(input);
        return outcome.kind === "published" ? ({ kind: "published" } as never) : outcome;
      },
    };
    await expect(runPagePublishingConformance(fixture(source))).rejects.toThrow(
      "is not a page outcome",
    );
  });

  it("fails a driver that throws a provider refusal instead of returning it", async () => {
    const honest = honestSource();
    const source: ProviderPagePublishingSource = {
      ...honest,
      publish: async (input) => {
        if (input.fileName === refusedRequest.fileName) throw new Error("refused");
        return honest.publish(input);
      },
    };
    await expect(runPagePublishingConformance(fixture(source))).rejects.toThrow(
      "publish rejected for a refused request",
    );
  });

  it("fails a driver that publishes on an instance with no signed-in account", async () => {
    const honest = honestSource();
    const source: ProviderPagePublishingSource = {
      ...honest,
      publish: async () => ({ kind: "published", address: "https://pages.example/p/1" }),
    };
    await expect(runPagePublishingConformance(fixture(source))).rejects.toThrow(
      "signed-out instance did not answer not signed in",
    );
  });

  it("fails a driver whose refusal text would show a file path on a card", async () => {
    const honest = honestSource();
    const source: ProviderPagePublishingSource = {
      ...honest,
      availability: (input) =>
        String(input.instanceId) === String(signedIn)
          ? { kind: "refused", reason: "Cannot read /Users/me/.config/provider" }
          : honest.availability(input),
    };
    await expect(runPagePublishingConformance(fixture(source))).rejects.toThrow(
      "is not a page availability",
    );
  });
});
