import { describe, expect, it } from "vitest";
import { classifyGithubAuthentication } from "./githubCapabilityPolicy";

describe("GitHub capability policy", () => {
  it("fails closed for insecure, ambient, ambiguous, and unknown sources", () => {
    expect(classifyGithubAuthentication({ externalToken: true })).toMatchObject({
      state: "external-token",
    });
    expect(classifyGithubAuthentication({ accounts: [] })).toMatchObject({ state: "unauthorized" });
    expect(
      classifyGithubAuthentication({ accounts: [{ login: "one", source: "plaintext" }] }),
    ).toMatchObject({ state: "insecure-storage" });
    expect(
      classifyGithubAuthentication({
        accounts: [{ login: "one", source: "/home/user/.config/gh/hosts.yml" }],
      }),
    ).toMatchObject({ state: "insecure-storage" });
    expect(
      classifyGithubAuthentication({ accounts: [{ login: "one", source: "mystery" }] }),
    ).toMatchObject({ state: "unavailable" });
    expect(
      classifyGithubAuthentication({
        accounts: [
          { login: "one", source: "keyring" },
          { login: "two", source: "keyring" },
        ],
      }),
    ).toMatchObject({ state: "unavailable" });
  });

  it("does not infer operation capability from scopes alone", () => {
    expect(
      classifyGithubAuthentication({
        accounts: [
          { login: "one", source: "keyring", gitProtocol: "https", scopes: ["repo", "read:org"] },
        ],
      }),
    ).toEqual({
      state: "scope-limited",
      account: { login: "one", gitProtocol: "https", scopes: ["read:org", "repo"] },
      capabilities: [
        { kind: "repository-catalogue", available: false, remediation: "operation-probe-required" },
        { kind: "issues-read", available: false, remediation: "operation-probe-required" },
        { kind: "pull-requests-read", available: false, remediation: "operation-probe-required" },
        { kind: "projects-read", available: false, remediation: "operation-probe-required" },
      ],
    });
  });

  it("only reports normalized operation probes and refuses a non-HTTPS account", () => {
    const observed = classifyGithubAuthentication({
      accounts: [
        {
          login: "one",
          source: "keyring",
          gitProtocol: "https",
          operationProbes: { "repository-catalogue": true, "issues-read": true },
        },
      ],
    });
    expect(observed.state).toBe("scope-limited");
    expect(
      observed.capabilities.map((capability) => ({
        kind: capability.kind,
        available: capability.available,
      })),
    ).toEqual([
      { kind: "repository-catalogue", available: true },
      { kind: "issues-read", available: true },
      { kind: "pull-requests-read", available: false },
      { kind: "projects-read", available: false },
    ]);
    expect(
      classifyGithubAuthentication({
        accounts: [{ login: "one", source: "keyring", gitProtocol: "ssh" }],
      }),
    ).toMatchObject({ state: "unavailable", capabilities: [] });
  });
});
