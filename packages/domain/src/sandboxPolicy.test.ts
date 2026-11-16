import { describe, expect, it } from "vitest";
import type { SandboxPolicy } from "@octant/contracts/sandbox-policy";
import {
  admitSandboxPolicy,
  resolveSandboxPolicy,
  intersectSandboxPolicies,
} from "./sandboxPolicy";

const policy: SandboxPolicy = {
  schemaVersion: 1,
  revision: 1,
  filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
  network: "existing-policy",
  credentials: "existing-policy",
  hostServices: "existing-policy",
};
const capabilities = {
  allowedFolders: true,
  protectedPaths: false,
  networkDeny: true,
  unrestrictedNetwork: true,
  isolatedCredentials: false,
  blockedHostServices: false,
};

describe("sandbox policy selection and admission", () => {
  it("preserves legacy behavior until a trusted policy is selected", () => {
    expect(resolveSandboxPolicy({})).toEqual({ source: "legacy" });
    expect(resolveSandboxPolicy({ settings: policy })).toEqual({ source: "settings", policy });
    const project = { ...policy, revision: 2 };
    const session = { ...policy, revision: 3 };
    expect(resolveSandboxPolicy({ settings: policy, project })).toEqual({
      source: "project",
      policy: project,
    });
    expect(resolveSandboxPolicy({ settings: policy, project, session })).toEqual({
      source: "session",
      policy: session,
    });
  });

  it("does not weaken unsupported requirements or turn denials into approval requests", () => {
    const selected = {
      ...policy,
      filesystem: {
        ...policy.filesystem,
        protectedPaths: [{ path: "/project/secret", mode: "deny" as const }],
      },
      credentials: "isolated" as const,
      hostServices: "blocked" as const,
    };
    expect(admitSandboxPolicy(selected, capabilities)).toEqual({
      status: "refused",
      code: "sandbox-policy-unsupported",
      rules: ["filesystem.protectedPaths", "credentials.isolated", "hostServices.blocked"],
    });
    expect(admitSandboxPolicy(policy, capabilities)).toEqual({ status: "admitted" });
  });

  it("requires a capability for every explicit expansion and network selection", () => {
    const selected: SandboxPolicy = {
      ...policy,
      filesystem: { ...policy.filesystem, readOnlyRoots: ["/shared"] },
      network: "deny",
    };
    expect(
      admitSandboxPolicy(selected, { ...capabilities, allowedFolders: false, networkDeny: false }),
    ).toMatchObject({ status: "refused", rules: ["filesystem.allowedFolders", "network.deny"] });
    expect(
      admitSandboxPolicy(
        { ...policy, network: "unrestricted" },
        { ...capabilities, unrestrictedNetwork: false },
      ),
    ).toMatchObject({ status: "refused", rules: ["network.unrestricted"] });
  });
  it("retains only the narrower helper folder and network grants", () => {
    const parent: SandboxPolicy = {
      ...policy,
      network: "deny",
      hostServices: "blocked",
      filesystem: { ...policy.filesystem, readOnlyRoots: ["/library"], readWriteRoots: ["/cache"] },
    };
    const child: SandboxPolicy = {
      ...policy,
      network: "unrestricted",
      filesystem: {
        ...policy.filesystem,
        readWriteRoots: ["/library", "/cache/build", "/outside"],
      },
    };
    expect(intersectSandboxPolicies(parent, child)).toMatchObject({
      network: "deny",
      hostServices: "blocked",
      filesystem: { readOnlyRoots: ["/library"], readWriteRoots: ["/cache/build"] },
    });
  });
  it("does not transfer a parent's local-service grant to another port or address", () => {
    const localServices = [{ host: "127.0.0.1" as const, port: 5173 }];
    const parent: SandboxPolicy = { ...policy, hostServices: "blocked", localServices };
    expect(
      intersectSandboxPolicies(parent, {
        ...parent,
        localServices: [
          ...localServices,
          { host: "127.0.0.1", port: 8080 },
          { host: "::1", port: 5173 },
        ],
      }).localServices,
    ).toEqual(localServices);
    expect(intersectSandboxPolicies(parent, policy).localServices).toEqual([]);
    expect(admitSandboxPolicy(parent, capabilities)).toMatchObject({
      status: "refused",
      rules: ["hostServices.blocked"],
    });
  });
});
