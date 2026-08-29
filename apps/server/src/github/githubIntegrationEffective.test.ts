import { describe, expect, it } from "vitest";
import type { ExtensionActivationState } from "@octant/contracts/extensions";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import {
  githubReadToolSetIfEffective,
  isFirstPartyIntegrationEffective,
  isGithubIntegrationEffective,
  isLinearIntegrationEffective,
} from "./githubIntegrationEffective";

const githubDigest = `sha256:${"c".repeat(64)}`;
const linearDigest = `sha256:${"e".repeat(64)}`;

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

function snapshotWithLinear(
  activation: ExtensionActivationState = effectiveActivation,
): Pick<ExtensionSnapshot, "packages"> {
  return {
    packages: [
      {
        extensionId: "10000000-0000-4000-8000-0000000000e1",
        packageId: "20000000-0000-4000-8000-0000000000e1",
        slug: "linear",
        displayName: "Linear",
        stateVersion: 1,
        version: "1.0.0",
        digest: linearDigest,
        source: { kind: "bundled", sourceRef: "app:linear" },
        compatibility: {
          platforms: ["macos"],
          modes: ["code"],
          providerFamilies: [],
        },
        activation,
        components: [
          {
            component: {
              id: "linear-integration",
              kind: "integration",
              displayName: "Linear",
              declaredCapabilities: ["network", "credentials"],
              entryPoint: "builtin:linear",
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
    ] as never,
  };
}

function snapshotWithGithub(
  activation: ExtensionActivationState = effectiveActivation,
): Pick<ExtensionSnapshot, "packages"> {
  return {
    packages: [
      {
        extensionId: "10000000-0000-4000-8000-0000000000c1",
        packageId: "20000000-0000-4000-8000-0000000000c1",
        slug: "github",
        displayName: "GitHub",
        stateVersion: 1,
        version: "1.0.0",
        digest: githubDigest,
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
    ] as never,
  };
}

describe("isFirstPartyIntegrationEffective", () => {
  it("treats a missing store row as the caller-supplied bundled default", () => {
    expect(
      isFirstPartyIntegrationEffective({ packages: [] }, "github-integration", {
        missingRow: "effective",
      }),
    ).toBe(true);
    expect(
      isFirstPartyIntegrationEffective({ packages: [] }, "linear-integration", {
        missingRow: "ineffective",
      }),
    ).toBe(false);
  });
});

describe("isGithubIntegrationEffective", () => {
  it("treats bundled GitHub as effective when the extension store has no row", () => {
    expect(isGithubIntegrationEffective({ packages: [] })).toBe(true);
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
});

describe("isLinearIntegrationEffective", () => {
  it("treats bundled Linear as not effective when the extension store has no row", () => {
    expect(isLinearIntegrationEffective({ packages: [] })).toBe(false);
  });

  it("is effective when the store row is installed, trusted, and desired", () => {
    expect(isLinearIntegrationEffective(snapshotWithLinear())).toBe(true);
  });

  it("is not effective when the plugin is disabled, untrusted, or not desired", () => {
    expect(
      isLinearIntegrationEffective(
        snapshotWithLinear({ ...effectiveActivation, pluginDesired: false }),
      ),
    ).toBe(false);
    expect(
      isLinearIntegrationEffective(snapshotWithLinear({ ...effectiveActivation, trusted: false })),
    ).toBe(false);
    expect(
      isLinearIntegrationEffective(
        snapshotWithLinear({ ...effectiveActivation, componentDesired: false }),
      ),
    ).toBe(false);
  });
});

describe("githubReadToolSetIfEffective", () => {
  it("injects the created GitHub tool set when the integration is effective", () => {
    const created = {
      definitions: [{ name: "octant_github", inputSchema: { type: "object" } as never }],
      execute: async () => ({ result: { from: "octant_github" } }),
    };
    expect(githubReadToolSetIfEffective(snapshotWithGithub(), () => created)).toBe(created);
    expect(githubReadToolSetIfEffective({ packages: [] }, () => created)).toBe(created);
  });
});
