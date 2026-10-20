import {
  decodeProviderInstance,
  decodeProviderObservedState,
  type ProviderInstance,
  type ProviderObservedState,
} from "@octant/contracts";
import type { ProviderDriver, ProviderPagePublishingSource } from "@octant/provider-sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeProviderPagePublishing } from "./providerPagePublishing";

const occurredAt = "2026-10-20T10:00:00.000Z";
const request = { fileName: "launch-plan.html", title: "Launch plan", html: "<p>Plan</p>" };

function instance(id: string, enabled = true): ProviderInstance {
  return decodeProviderInstance({
    id,
    displayName: `Account ${id.slice(-1)}`,
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
    },
    enabled,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

function observed(
  instanceId: ProviderInstance["id"],
  options: { readonly readiness?: ProviderObservedState["readiness"]; readonly pages?: boolean },
): ProviderObservedState {
  return decodeProviderObservedState({
    instanceId,
    readiness: options.readiness ?? "ready",
    processState: "stopped",
    models: [],
    capabilities: {
      streaming: "supported",
      resume: "supported",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "supported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "supported",
      diffs: "supported",
      taskProgress: "supported",
      nativeChildAgents: "unavailable",
      harnessAutoReview: "unsupported",
      nativeAttachments: "supported",
      nativeWebResearch: "unsupported",
      appManagedTools: "supported",
      citations: "supported",
      ...(options.pages === false ? {} : { artifactPublish: "supported" }),
    },
    observedAt: occurredAt,
  });
}

/** A driver that offers nothing but the probe and session surface the type requires. */
function driver(pagePublishing?: ProviderPagePublishingSource): ProviderDriver {
  const unsupported = () =>
    Effect.fail({ category: "unsupported" as const, message: "Not used by this test." });
  return {
    kind: "claude",
    probe: unsupported,
    acquire: unsupported,
    ...(pagePublishing === undefined ? {} : { pagePublishing }),
  };
}

const publishing: ProviderPagePublishingSource = {
  availability: () => ({ kind: "ready", account: "Work account" }),
  publish: async (input) => ({
    kind: "published",
    address: `https://pages.example/p/${input.fileName}`,
  }),
};

const a = instance("00000000-0000-4000-8000-00000000000a");
const b = instance("00000000-0000-4000-8000-00000000000b");
const c = instance("00000000-0000-4000-8000-00000000000c");
const d = instance("00000000-0000-4000-8000-00000000000d", false);

describe("provider page publishing", () => {
  it("lists only enabled instances whose driver publishes pages and whose runtime declares it", () => {
    const port = makeProviderPagePublishing({
      instances: () => [a, b, c, d],
      resolveDriver: (candidate) =>
        String(candidate.id) === String(b.id) ? driver() : driver(publishing),
      observedState: (id) => {
        if (String(id) === String(c.id)) return observed(id, { pages: false });
        return observed(id, {});
      },
    });

    expect(port.publishers()).toEqual([
      {
        instanceId: a.id,
        label: a.displayName,
        availability: { kind: "ready", account: "Work account" },
      },
    ]);
  });

  it("leaves out an instance whose runtime is not ready, whose driver says it is absent, or whose answer is not a page availability", () => {
    const port = makeProviderPagePublishing({
      instances: () => [a, b, c],
      resolveDriver: (candidate) => {
        if (String(candidate.id) === String(b.id)) {
          return driver({ ...publishing, availability: () => ({ kind: "absent" }) });
        }
        if (String(candidate.id) === String(c.id)) {
          return driver({
            ...publishing,
            availability: () => ({ kind: "refused", reason: "see /etc/provider" }),
          });
        }
        return driver(publishing);
      },
      observedState: (id) =>
        observed(id, { readiness: String(id) === String(a.id) ? "unauthenticated" : "ready" }),
    });

    expect(port.publishers()).toEqual([]);
  });

  it("refuses to publish on an instance it does not list, before asking any driver", async () => {
    let asked = 0;
    const port = makeProviderPagePublishing({
      instances: () => [a],
      resolveDriver: () =>
        driver({
          ...publishing,
          publish: async () => {
            asked += 1;
            return { kind: "published", address: "https://pages.example/p/1" };
          },
        }),
      observedState: (id) => observed(id, { pages: false }),
    });

    await expect(port.publish(a.id, request)).resolves.toEqual({
      kind: "refused",
      message: "This provider cannot publish pages.",
    });
    expect(asked).toBe(0);
  });

  it("publishes through the listed instance's driver and returns the decoded address", async () => {
    const port = makeProviderPagePublishing({
      instances: () => [a],
      resolveDriver: () => driver(publishing),
      observedState: (id) => observed(id, {}),
    });

    await expect(port.publish(a.id, request)).resolves.toEqual({
      kind: "published",
      address: "https://pages.example/p/launch-plan.html",
    });
  });

  it("reports a driver that rejects or answers in another shape as unavailable in fixed words", async () => {
    const rejecting = makeProviderPagePublishing({
      instances: () => [a],
      resolveDriver: () =>
        driver({
          ...publishing,
          publish: async () => {
            throw new Error("private transport detail");
          },
        }),
      observedState: (id) => observed(id, {}),
    });
    const malformed = makeProviderPagePublishing({
      instances: () => [a],
      resolveDriver: () =>
        driver({ ...publishing, publish: async () => ({ kind: "published" }) as never }),
      observedState: (id) => observed(id, {}),
    });

    await expect(rejecting.publish(a.id, request)).resolves.toEqual({
      kind: "unavailable",
      message: "The provider could not be asked to publish the page.",
    });
    await expect(malformed.publish(a.id, request)).resolves.toEqual({
      kind: "unavailable",
      message: "The provider did not report the publish in a form this host accepts.",
    });
  });

  it("refuses a request that names a folder instead of a file", async () => {
    const port = makeProviderPagePublishing({
      instances: () => [a],
      resolveDriver: () => driver(publishing),
      observedState: (id) => observed(id, {}),
    });

    await expect(port.publish(a.id, { ...request, fileName: "../plan.html" })).resolves.toEqual({
      kind: "refused",
      message: "The page is not one this host can publish.",
    });
  });
});
