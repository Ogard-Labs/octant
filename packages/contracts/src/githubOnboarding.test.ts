import { describe, expect, it } from "vitest";
import {
  decodeGithubAuthenticationSnapshot,
  decodeGithubAuthenticationCommand,
} from "./githubOnboarding";

describe("GitHub onboarding contracts", () => {
  it("accepts a bounded ready account snapshot without credential material", () => {
    expect(
      decodeGithubAuthenticationSnapshot({
        state: "ready",
        account: { login: "octant", gitProtocol: "https", scopes: ["read:org", "repo"] },
        capabilities: [{ kind: "repository-catalogue", available: true }],
      }),
    ).toMatchObject({ state: "ready", account: { login: "octant" } });
  });

  it("accepts only the pinned device-flow URL and a bounded code", () => {
    expect(
      decodeGithubAuthenticationSnapshot({
        state: "unauthorized",
        capabilities: [],
        interaction: {
          kind: "device-flow",
          verificationUri: "https://github.com/login/device",
          userCode: "ABCD-EFGH",
        },
      }),
    ).toMatchObject({ interaction: { userCode: "ABCD-EFGH" } });
    expect(() =>
      decodeGithubAuthenticationSnapshot({
        state: "unauthorized",
        capabilities: [],
        interaction: {
          kind: "device-flow",
          verificationUri: "https://attacker.example/device",
          userCode: "ABCD-EFGH",
        },
      }),
    ).toThrow();
  });

  it("rejects token-like and unknown data at the renderer boundary", () => {
    expect(() =>
      decodeGithubAuthenticationSnapshot({
        state: "ready",
        account: { login: "ghp_abcdefghijklmnopqrstuvwxyz", gitProtocol: "https", scopes: [] },
        capabilities: [],
      }),
    ).toThrow();
    expect(() =>
      decodeGithubAuthenticationCommand({ kind: "refresh", scopes: ["repo"], extra: true }),
    ).toThrow();
  });
});
