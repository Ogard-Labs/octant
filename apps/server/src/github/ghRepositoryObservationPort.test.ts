import { describe, expect, it, vi } from "vitest";
import { GhRepositoryObservationPort } from "./ghRepositoryObservationPort";

const identity = { owner: "octant", name: "octant" };
const signal = new AbortController().signal;

function repositoryJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    node_id: "R_kgDOAbc123",
    name: "octant",
    owner: { login: "octant" },
    visibility: "private",
    default_branch: "development",
    ...overrides,
  });
}

function createPort(run: ReturnType<typeof vi.fn>) {
  return new GhRepositoryObservationPort({
    command: { run: run as never },
    inheritedEnvironment: {
      PATH: "/usr/bin",
      HOME: "/Users/host",
      GH_TOKEN: "ghp_0123456789abcdefghij",
    },
  });
}

describe("gh repository observation port", () => {
  it("observes one repository through a fixed token-free gh api read", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: repositoryJson() }));
    const port = createPort(run);
    const result = await port.observeRepository(identity, signal);
    expect(result).toEqual({
      kind: "observed",
      repository: {
        nodeId: "R_kgDOAbc123",
        owner: "octant",
        name: "octant",
        visibility: "private",
        defaultBranch: "development",
      },
    });
    expect(run).toHaveBeenCalledOnce();
    const [args, options] = run.mock.calls[0] as unknown as [
      readonly string[],
      { environment: NodeJS.ProcessEnv },
    ];
    expect(args).toEqual(["api", "repos/octant/octant"]);
    expect(options.environment.GH_TOKEN).toBeUndefined();
  });

  it("refuses hostile identity without spawning anything", async () => {
    const run = vi.fn();
    const port = createPort(run);
    expect(await port.observeRepository({ owner: "../etc", name: "passwd" }, signal)).toEqual({
      kind: "unavailable",
    });
    expect(await port.observeRepository({ owner: "octant", name: "a/../../b" }, signal)).toEqual({
      kind: "unavailable",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("classifies not-found, unauthorized, and transient failures", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["gh: Not Found (HTTP 404)", "not-found"],
      ["gh: Bad credentials (HTTP 401)", "unauthorized"],
      ["gh: Must have push access (HTTP 403)", "unauthorized"],
      ["dial tcp: no such host", "unavailable"],
    ];
    for (const [stderr, kind] of cases) {
      const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr }));
      expect(await createPort(run).observeRepository(identity, signal)).toEqual({ kind });
    }
  });

  it("treats malformed, oversized, or identity-inconsistent payloads as unavailable", async () => {
    const malformed = vi.fn(async () => ({ exitCode: 0, stdout: "not json" }));
    expect(await createPort(malformed).observeRepository(identity, signal)).toEqual({
      kind: "unavailable",
    });
    const badVisibility = vi.fn(async () => ({
      exitCode: 0,
      stdout: repositoryJson({ visibility: "secret" }),
    }));
    expect(await createPort(badVisibility).observeRepository(identity, signal)).toEqual({
      kind: "unavailable",
    });
    const badNode = vi.fn(async () => ({
      exitCode: 0,
      stdout: repositoryJson({ node_id: "bad node id\u0000" }),
    }));
    expect(await createPort(badNode).observeRepository(identity, signal)).toEqual({
      kind: "unavailable",
    });
    const oversized = vi.fn(async () => ({
      exitCode: 0,
      stdout: `{"pad":"${"x".repeat(5 * 1024 * 1024)}"}`,
    }));
    expect(await createPort(oversized).observeRepository(identity, signal)).toEqual({
      kind: "unavailable",
    });
    const thrown = vi.fn(async () => {
      throw new Error("gh-cli-unavailable");
    });
    expect(await createPort(thrown).observeRepository(identity, signal)).toEqual({
      kind: "unavailable",
    });
  });

  it("reports renamed repositories exactly as GitHub resolves them", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: repositoryJson({ name: "renamed", owner: { login: "other-org" } }),
    }));
    const result = await createPort(run).observeRepository(identity, signal);
    expect(result.kind).toBe("observed");
    if (result.kind !== "observed") return;
    expect(result.repository.owner).toBe("other-org");
    expect(result.repository.name).toBe("renamed");
  });

  it("observes a repository without a default branch", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: repositoryJson({ default_branch: undefined }),
    }));
    const result = await createPort(run).observeRepository(identity, signal);
    expect(result).toEqual({
      kind: "observed",
      repository: {
        nodeId: "R_kgDOAbc123",
        owner: "octant",
        name: "octant",
        visibility: "private",
      },
    });
  });
});
