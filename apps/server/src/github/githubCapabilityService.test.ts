import { describe, expect, it, vi } from "vitest";
import { GithubCapabilityService } from "./githubCapabilityService";

describe("GithubCapabilityService", () => {
  it("preserves unauthorized rather than rewriting it as an unavailable host", async () => {
    const service = new GithubCapabilityService({
      observe: async () => ({ kind: "unauthorized" }),
      execute: async () => undefined,
    } as any);
    await expect(service.snapshot(new AbortController().signal)).resolves.toMatchObject({
      state: "unauthorized",
    });
  });

  it("returns a bounded device-flow interaction to the requesting client", async () => {
    const service = new GithubCapabilityService({
      observe: async () => ({ kind: "unauthorized" }),
      execute: async () => ({ kind: "device-flow", userCode: "ABCD-EFGH" }),
    } as any);

    await expect(
      service.execute(
        { kind: "setup", confirmation: "confirm-github-setup" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      state: "unauthorized",
      capabilities: [],
      interaction: {
        kind: "device-flow",
        verificationUri: "https://github.com/login/device",
        userCode: "ABCD-EFGH",
      },
    });
  });

  it("advertises only live-probed operations for an observed secure account", async () => {
    const probeOperations = vi.fn(async () => ({
      "repository-catalogue": true,
      "issues-read": true,
      "pull-requests-read": true,
      "projects-read": false,
    }));
    const service = new GithubCapabilityService(
      {
        observe: async () => ({
          kind: "observed",
          accounts: [
            { login: "octocat", source: "keyring", scopes: ["repo"], gitProtocol: "https" },
          ],
        }),
      } as any,
      { probes: { probeOperations } },
    );

    await expect(service.snapshot(new AbortController().signal)).resolves.toMatchObject({
      state: "scope-limited",
      capabilities: [
        { kind: "repository-catalogue", available: true },
        { kind: "issues-read", available: true },
        { kind: "pull-requests-read", available: true },
        { kind: "projects-read", available: false },
      ],
    });
    expect(probeOperations).toHaveBeenCalledOnce();
  });

  it("caches probe results briefly and re-probes after an authentication command", async () => {
    let clock = 0;
    const probeOperations = vi.fn(async () => ({
      "repository-catalogue": true,
      "issues-read": true,
      "pull-requests-read": true,
      "projects-read": true,
    }));
    const service = new GithubCapabilityService(
      {
        observe: async () => ({
          kind: "observed",
          accounts: [
            { login: "octocat", source: "keyring", scopes: ["repo"], gitProtocol: "https" },
          ],
        }),
        execute: async () => ({ kind: "completed" }),
      } as any,
      { probes: { probeOperations }, now: () => clock },
    );
    const signal = new AbortController().signal;

    await expect(service.snapshot(signal)).resolves.toMatchObject({ state: "ready" });
    clock += 1_000;
    await service.snapshot(signal);
    expect(probeOperations).toHaveBeenCalledTimes(1);

    await service.execute(
      { kind: "refresh", confirmation: "confirm-github-refresh", scopes: ["read:project"] },
      signal,
    );
    expect(probeOperations).toHaveBeenCalledTimes(2);
  });

  it("never probes operations without an observed account", async () => {
    const probeOperations = vi.fn(async () => ({}));
    const service = new GithubCapabilityService(
      { observe: async () => ({ kind: "unauthorized" }) } as any,
      { probes: { probeOperations } },
    );

    await expect(service.snapshot(new AbortController().signal)).resolves.toMatchObject({
      state: "unauthorized",
    });
    expect(probeOperations).not.toHaveBeenCalled();
  });

  it("fails closed when the normalized port observation violates the renderer contract", async () => {
    const service = new GithubCapabilityService({
      observe: async () => ({
        kind: "observed",
        accounts: [
          {
            login: "x".repeat(129),
            source: "keyring",
            scopes: [],
            gitProtocol: "https",
          },
        ],
      }),
    } as any);

    await expect(service.snapshot(new AbortController().signal)).resolves.toMatchObject({
      state: "unavailable",
      capabilities: [],
    });
  });
});
