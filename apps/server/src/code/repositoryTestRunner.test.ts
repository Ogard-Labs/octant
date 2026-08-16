import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RepositoryTestRunner } from "./repositoryTestRunner";

const definition = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Unit tests",
  source: {
    kind: "package-script",
    packagePath: "package.json",
    packageManager: "bun",
    script: "test",
  },
  argv: ["bun", "run", "test"],
  cwd: ".",
  environmentRefs: ["TEST_DATABASE_URL"],
  timeoutMs: 60_000,
  artifactPaths: ["artifacts/report.json", "artifacts/missing.xml"],
} as const;

describe("RepositoryTestRunner", () => {
  it("records sanitized structured execution with bounded output and explicit missing artifacts", async () => {
    const execute = vi.fn().mockResolvedValue({
      termination: "exited",
      exitCode: 0,
      stdout: new TextEncoder().encode("secret ok\n"),
      stderr: new Uint8Array(),
      parserFailed: false,
      cleanupUncertain: false,
    });
    const artifacts = vi
      .fn()
      .mockResolvedValueOnce(new Uint8Array([1, 2]))
      .mockResolvedValueOnce(undefined);
    const runner = new RepositoryTestRunner({
      realpath: async (path) => path,
      execute,
      readArtifact: artifacts,
      now: (() => {
        const values = ["2026-07-21T12:00:00.000Z", "2026-07-21T12:00:01.000Z"];
        return () => values.shift() ?? "2026-07-21T12:00:01.000Z";
      })(),
      newId: () => "20000000-0000-4000-8000-000000000001",
    });

    const run = await runner.run({
      definition: definition as never,
      threadId: "30000000-0000-4000-8000-000000000001" as never,
      checkoutId: "40000000-0000-4000-8000-000000000001" as never,
      checkoutRevision: "a".repeat(40),
      executionPolicy: "approval-gated",
      checkoutRoot: "/private/repository",
      environment: { TEST_DATABASE_URL: "secret", UNSCOPED: "ignored" },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["bun", "run", "test"],
        cwd: "/private/repository",
        environment: { TEST_DATABASE_URL: "secret" },
      }),
      undefined,
    );
    expect(run).toMatchObject({
      exitCode: 0,
      verdict: "inconclusive",
      artifacts: [
        { path: "artifacts/report.json", status: "retained", byteLength: 2 },
        { path: "artifacts/missing.xml", status: "missing", byteLength: 0 },
      ],
      concerns: ["missing-artifact"],
    });
    expect(run.stdout.text).toBe("[REDACTED] ok\n");
    expect(JSON.stringify(run)).not.toContain("secret");
  });

  it("makes output overflow, timeout, parser failure, and cleanup uncertainty inconclusive", async () => {
    const runner = new RepositoryTestRunner({
      realpath: async (path) => path,
      execute: async () => ({
        termination: "timed-out",
        exitCode: null,
        stdout: new Uint8Array(16 * 1024 * 1024 + 1),
        stderr: new Uint8Array(),
        parserFailed: true,
        cleanupUncertain: true,
      }),
      readArtifact: async () => undefined,
      now: () => "2026-07-21T12:00:00.000Z",
      newId: () => "20000000-0000-4000-8000-000000000001",
    });
    const run = await runner.run({
      definition: { ...definition, artifactPaths: [] } as never,
      threadId: "30000000-0000-4000-8000-000000000001" as never,
      checkoutId: "40000000-0000-4000-8000-000000000001" as never,
      checkoutRevision: "a".repeat(40),
      executionPolicy: "approval-gated",
      checkoutRoot: "/private/repository",
      environment: {},
    });
    expect(run).toMatchObject({
      verdict: "inconclusive",
      concerns: expect.arrayContaining([
        "output-truncated",
        "timeout",
        "parser-failed",
        "cleanup-uncertain",
      ]),
    });
  });

  it("distinguishes an unavailable artifact read from a missing artifact", async () => {
    const runner = new RepositoryTestRunner({
      realpath: async (path) => path,
      execute: async () => ({
        termination: "exited",
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        parserFailed: false,
        cleanupUncertain: false,
      }),
      readArtifact: async () => {
        throw new Error("private read failure");
      },
      now: () => "2026-07-21T12:00:00.000Z",
      newId: () => "20000000-0000-4000-8000-000000000001",
    });

    const run = await runner.run({
      definition: { ...definition, artifactPaths: ["artifacts/report.json"] } as never,
      threadId: "30000000-0000-4000-8000-000000000001" as never,
      checkoutId: "40000000-0000-4000-8000-000000000001" as never,
      checkoutRevision: "a".repeat(40),
      executionPolicy: "approval-gated",
      checkoutRoot: "/private/repository",
      environment: {},
    });

    expect(run).toMatchObject({
      verdict: "inconclusive",
      artifacts: [{ path: "artifacts/report.json", status: "unavailable", byteLength: 0 }],
      concerns: ["artifact-read-unavailable"],
    });
  });

  it("rejects a cwd symlink that escapes the canonical checkout root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "octant-test-runner-"));
    const checkoutRoot = join(parent, "checkout");
    const outside = join(parent, "outside");
    mkdirSync(checkoutRoot);
    mkdirSync(outside);
    symlinkSync(outside, join(checkoutRoot, "escape"), "dir");
    const execute = vi.fn();
    const runner = new RepositoryTestRunner({
      execute,
      readArtifact: async () => undefined,
      now: () => "2026-07-21T12:00:00.000Z",
      newId: () => "20000000-0000-4000-8000-000000000001",
    });

    try {
      const run = await runner.run({
        definition: { ...definition, cwd: "escape", artifactPaths: [] } as never,
        threadId: "30000000-0000-4000-8000-000000000001" as never,
        checkoutId: "40000000-0000-4000-8000-000000000001" as never,
        checkoutRevision: "a".repeat(40),
        executionPolicy: "approval-gated",
        checkoutRoot,
        environment: {},
      });

      expect(execute).not.toHaveBeenCalled();
      expect(run).toMatchObject({ termination: "unavailable", verdict: "unavailable" });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
