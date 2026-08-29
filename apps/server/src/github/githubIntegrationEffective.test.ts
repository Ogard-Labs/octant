import { describe, expect, it } from "vitest";
import type { ExtensionActivationState } from "@octant/contracts/extensions";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  githubReadToolSetIfEffective,
  isGithubIntegrationEffective,
} from "./githubIntegrationEffective";

const digest = `sha256:${"c".repeat(64)}`;

const effectiveActivation: ExtensionActivationState = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};

function snapshotWithGithub(
  activation: ExtensionActivationState = effectiveActivation,
): ExtensionSnapshot {
  return {
    sequence: 1 as never,
    snapshotAt: "2026-08-29T00:00:00.000Z" as never,
    packages: [
      {
        extensionId: "10000000-0000-4000-8000-0000000000c1",
        packageId: "20000000-0000-4000-8000-0000000000c1",
        slug: "github",
        displayName: "GitHub",
        stateVersion: 1 as never,
        version: "1.0.0",
        digest,
        source: { kind: "bundled", sourceRef: "app:github" },
        compatibility: {
          platforms: ["macos"],
          modes: ["code"],
          providerFamilies: [],
        },
        activation,
        components: [
          {
            component: {
              id: "github-integration",
              kind: "integration",
              displayName: "GitHub",
              declaredCapabilities: ["network", "credentials"],
              entryPoint: "builtin:github",
            },
            activation,
            effectiveState:
              activation.pluginDesired && activation.trusted && activation.componentDesired
                ? { kind: "effective" }
                : { kind: "blocked", reason: "plugin-disabled" },
          },
        ],
        diagnostics: [],
      },
    ],
    collisions: [],
  };
}

describe("isGithubIntegrationEffective", () => {
  it("treats bundled GitHub as effective when the extension store has no row", () => {
    expect(
      isGithubIntegrationEffective({
        sequence: 0 as never,
        snapshotAt: "2026-08-29T00:00:00.000Z" as never,
        packages: [],
        collisions: [],
      }),
    ).toBe(true);
  });

  it("stays effective when the store row is installed, trusted, and desired", () => {
    expect(isGithubIntegrationEffective(snapshotWithGithub())).toBe(true);
  });

  it("is not effective when the plugin is disabled, untrusted, or not desired", () => {
    expect(
      isGithubIntegrationEffective(
        snapshotWithGithub({ ...effectiveActivation, pluginDesired: false }),
      ),
    ).toBe(false);
    expect(
      isGithubIntegrationEffective(snapshotWithGithub({ ...effectiveActivation, trusted: false })),
    ).toBe(false);
    expect(
      isGithubIntegrationEffective(
        snapshotWithGithub({ ...effectiveActivation, componentDesired: false }),
      ),
    ).toBe(false);
  });

  it("omits octant_github when the integration is not effective", async () => {
    const created = {
      definitions: [{ name: "octant_github", inputSchema: { type: "object" } as never }],
      execute: async () => ({ result: { from: "octant_github" } }),
    };
    const set = githubReadToolSetIfEffective(
      snapshotWithGithub({ ...effectiveActivation, pluginDesired: false }),
      () => created,
    );
    expect(set.definitions).toEqual([]);
    expect(await set.execute({ name: "octant_github", inputJson: "{}" })).toEqual({
      result: { error: "tool-unavailable" },
      isError: true,
    });
  });

  it("injects the created GitHub tool set when the integration is effective", () => {
    const created = {
      definitions: [{ name: "octant_github", inputSchema: { type: "object" } as never }],
      execute: async () => ({ result: { from: "octant_github" } }),
    };
    expect(githubReadToolSetIfEffective(snapshotWithGithub(), () => created)).toBe(created);
    expect(
      githubReadToolSetIfEffective(
        {
          sequence: 0 as never,
          snapshotAt: "2026-08-29T00:00:00.000Z" as never,
          packages: [],
          collisions: [],
        },
        () => created,
      ),
    ).toBe(created);
  });
});
