import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { OctantShield, type ShieldModelPort, type ShieldThreadFacts } from "./octantShield";
import { shieldAllowsNetwork } from "./shieldNetworkReview";

const root = "/Users/dev/app";

function shieldAnswering(verdict: "allow" | "deny", facts: Partial<ShieldThreadFacts> = {}) {
  const prompts: string[] = [];
  const model: ShieldModelPort = {
    model: {
      providerInstanceId: "7b0c3f1e-2a4d-4e8b-9c1a-0d2e3f4a5b6c" as ProviderInstanceId,
      modelId: "small-model" as ProviderModelId,
    },
    complete: vi.fn(async ({ prompt }) => {
      prompts.push(prompt);
      return {
        status: "answered" as const,
        text: JSON.stringify({ verdict, reason: "The person asked to install packages." }),
      };
    }),
  };
  const shield = new OctantShield({
    facts: {
      reviewing: () => ({ level: "provider-review", model, projectId: "project-1" }),
      tainted: () => false,
      watcherLabels: () => [],
      personMessages: () => ["Install the dependencies and run the tests."],
      projectCommands: () => [],
      ...facts,
    },
    clock: () => "2026-11-01T12:00:00.000Z",
  });
  const shown: string[] = [];
  return {
    prompts,
    port: {
      review: (request: Parameters<OctantShield["review"]>[0]) => shield.review(request),
      recordOnTranscript: (input: { readonly summary: string }) => shown.push(input.summary),
    },
    shown,
  };
}

describe("Octant Shield on an unlisted host", () => {
  it("lets a host through only when Shield allows it, and shows the decision on the thread", async () => {
    const allowing = shieldAnswering("allow");
    await expect(
      shieldAllowsNetwork(allowing.port, {
        threadId: "t",
        host: "registry.npmjs.org",
        port: 443,
        via: "command",
        boundRoot: root,
      }),
    ).resolves.toMatchObject({ allowed: true });
    expect(allowing.prompts.join("\n")).toContain("registry.npmjs.org:443");
    expect(allowing.shown).toEqual(["Network: registry.npmjs.org:443"]);

    const denying = shieldAnswering("deny");
    await expect(
      shieldAllowsNetwork(denying.port, {
        threadId: "t",
        host: "evil.example",
        port: 443,
        via: "opencode",
        boundRoot: root,
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it("hands a tainted thread's host to the person without asking the model", async () => {
    const tainted = shieldAnswering("allow", { tainted: () => true });
    await expect(
      shieldAllowsNetwork(tainted.port, {
        threadId: "t",
        host: "registry.npmjs.org",
        port: 443,
        via: "command",
        boundRoot: root,
      }),
    ).resolves.toEqual({ allowed: false });
    expect(tainted.prompts).toEqual([]);
  });

  it("allows nothing on a thread Shield does not review, or with no Shield at all", async () => {
    const elsewhere = shieldAnswering("allow", { reviewing: () => undefined });
    const request = {
      threadId: "t",
      host: "registry.npmjs.org",
      port: 443,
      via: "command",
      boundRoot: root,
    };
    await expect(shieldAllowsNetwork(elsewhere.port, request)).resolves.toEqual({
      allowed: false,
    });
    expect(elsewhere.shown).toEqual([]);
    await expect(shieldAllowsNetwork(undefined, request)).resolves.toEqual({ allowed: false });
  });
});
