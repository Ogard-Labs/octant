import { rmSync } from "node:fs";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { describe, expect, it, vi } from "vitest";
import { decodeCodeOperationCommand } from "@octant/contracts";
import { prepareGitHunks, selectedGitHunkPatch } from "./gitHunks";
import { GitMutationPort } from "./gitMutationPort";
import { GitService } from "./gitService";
import type { GitObservation } from "./gitObservationPort";

const patch =
  "diff --git a/file.txt b/file.txt\nindex " +
  "a".repeat(40) +
  ".." +
  "b".repeat(40) +
  " 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
const observed: GitObservation = {
  status: "ready",
  checkoutRoot: "/repo",
  head: { kind: "branch", name: "main", oid: "a".repeat(40) },
  statusEntries: [{ path: "file.txt", index: " ", worktree: "M" }],
  changedPaths: ["file.txt"],
  stagedSummary: [],
  diff: { text: patch, byteLength: Buffer.byteLength(patch), truncated: false },
  remotes: [],
  upstream: null,
  worktrees: [],
  stateToken: "c".repeat(64),
  insertions: 1,
  deletions: 1,
};
const scoped = (text = patch) => ({
  status: "ready" as const,
  paths: ["file.txt"],
  diff: { text, byteLength: Buffer.byteLength(text), truncated: false },
});
const command = {
  kind: "stage-git-hunks",
  operationId: "10000000-0000-4000-8000-000000000001",
  threadId: "10000000-0000-4000-8000-000000000002",
  checkoutId: "10000000-0000-4000-8000-000000000003",
  gitOperationId: "10000000-0000-4000-8000-000000000004",
  comparisonOperationId: "10000000-0000-4000-8000-000000000005",
  selected: ["d".repeat(64)],
};

function nativeHarness(checkOutput = "", beforeExec?: (args: readonly string[]) => void) {
  const execFile = vi.fn(
    async (
      _file: string,
      args: readonly string[],
      _env: NodeJS.ProcessEnv,
      _signal: AbortSignal,
      stdin?: string,
    ) => {
      beforeExec?.(args);
      if (args.includes("rev-parse"))
        return { exitCode: 0, stdout: "/repo/.git/index.lock\n", stderr: "" };
      expect(stdin).toBe(patch);
      return { exitCode: 0, stdout: "", stderr: args.includes("--check") ? checkOutput : "" };
    },
  );
  return {
    execFile,
    port: new GitMutationPort({ execFile, pathExists: async () => false }, { onServer: true }),
  };
}

describe("exact selected Git hunks", () => {
  it("decodes identities only and refuses client patch bytes, duplicates and empty selections", () => {
    expect(decodeCodeOperationCommand(command)).toEqual(command);
    for (const invalid of [
      { ...command, patch },
      { ...command, selected: [] },
      { ...command, selected: [...command.selected, ...command.selected] },
    ])
      expect(() => decodeCodeOperationCommand(invalid)).toThrow();
  });
  it("binds identity to scope and exact native bytes, preserving header-like content and EOF markers", () => {
    const text = patch.replace(
      "-old\n+new\n",
      "--- removed\n+++ added\n\\ No newline at end of file\n",
    );
    const comparison = prepareGitHunks("unstaged", observed, scoped(text));
    expect(comparison.hunks).toHaveLength(1);
    expect(comparison.hunks[0]).toMatchObject({ path: "file.txt", oldStart: 1, newStart: 1 });
    expect(selectedGitHunkPatch(comparison, [comparison.hunks[0]!.id])).toBe(text);
    expect(prepareGitHunks("staged", observed, scoped(text)).hunks[0]!.id).not.toBe(
      comparison.hunks[0]!.id,
    );
    expect(selectedGitHunkPatch(comparison, ["0".repeat(64)])).toBeUndefined();
  });
  it("refuses nonregular modes, ambiguous paths and truncated bytes instead of inventing editable hunks", () => {
    expect(
      prepareGitHunks("unstaged", observed, scoped(patch.replace("100644", "160000"))).hunks,
    ).toEqual([]);
    expect(
      prepareGitHunks("unstaged", observed, { ...scoped(), paths: ["other.txt"] }).hunks,
    ).toEqual([]);
    expect(
      prepareGitHunks("unstaged", observed, {
        ...scoped(),
        diff: { ...scoped().diff, truncated: true },
      }).unavailable,
    ).toEqual([{ reason: "truncated" }]);
  });
  it.each(["stage", "unstage", "reverse"] as const)(
    "uses exact stdin for %s with explicit index/worktree direction",
    async (action) => {
      const { port, execFile } = nativeHarness();
      expect(
        await port.applyHunks({
          checkoutRoot: "/repo",
          action,
          patch,
          beforeApply: async () => true,
          current: () => true,
          executionPolicy: "full-access",
        }),
      ).toEqual({ status: "applied" });
      const args = execFile.mock.calls
        .filter((call) => call[1].includes("apply"))
        .map((call) => call[1]);
      expect(args).toHaveLength(2);
      expect(args[0]).toContain("--check");
      expect(args[1]).not.toContain("--check");
      expect(args[1]!.includes("--cached")).toBe(action !== "reverse");
      expect(args[1]!.includes("--reverse")).toBe(action !== "stage");
    },
  );
  it("refuses relocated preflight and authority lost during held final proof without launching apply", async () => {
    const shifted = nativeHarness("Hunk #1 succeeded at 4 (offset 3 lines).\n");
    expect(
      await shifted.port.applyHunks({
        checkoutRoot: "/repo",
        action: "reverse",
        patch,
        current: () => true,
        beforeApply: async () => true,
      }),
    ).toEqual({ status: "rejected", reason: "hunk-offset" });
    expect(shifted.execFile.mock.calls.filter((call) => call[1].includes("apply"))).toHaveLength(1);
    const { port, execFile } = nativeHarness();
    let current = true;
    expect(
      await port.applyHunks({
        checkoutRoot: "/repo",
        action: "stage",
        patch,
        current: () => current,
        beforeApply: async () => {
          await Promise.resolve();
          current = false;
          return true;
        },
      }),
    ).toEqual({ status: "rejected", reason: "stale-state" });
    expect(execFile.mock.calls.filter((call) => call[1].includes("apply"))).toHaveLength(1);
  });
  it("rereads canonical content after preflight even when coarse status token stays unchanged", async () => {
    let diff = patch;
    const native = nativeHarness("", (args) => {
      if (args.includes("--check")) diff = patch.replace("+new", "+changed externally");
    });
    const unused = async () => ({ status: "failed" as const });
    const service = new GitService(
      { observe: async () => observed, readDiff: async () => scoped(diff) },
      {
        applyHunks: native.port.applyHunks.bind(native.port),
        stage: unused,
        unstage: unused,
        discard: unused,
        commit: unused,
        push: unused,
        revertCommit: unused,
        snapshotWorkingTree: async () => ({ status: "failed" as const }),
        restoreWorkingTree: unused,
        releaseCheckpoint: async () => {},
      },
    );
    const input = {
      checkoutId: "checkout",
      checkoutRoot: "/repo",
      scope: "unstaged" as const,
      current: () => true,
    };
    const comparison = await service.prepareHunks(input);
    expect(comparison.status).toBe("ready");
    if (comparison.status !== "ready") throw Error("Missing comparison");
    expect(
      await service.applyHunks({
        ...input,
        action: "stage",
        executionPolicy: "full-access",
        selected: [comparison.hunks[0]!.id],
        expectedStateToken: comparison.stateToken,
        expectedDigest: comparison.digest,
      }),
    ).toEqual({ status: "rejected", reason: "stale-state" });
    expect(native.execFile.mock.calls.filter((call) => call[1].includes("apply"))).toHaveLength(1);
  });
});

it("does not launch apply when synchronous confinement work exhausts the existing command deadline", async () => {
  const fake = createFakeSandboxConfinement("octant-hunk-deadline-");
  let clock = 0;
  let preparations = 0;
  const time = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const execFile = vi.fn(async (_file: string, args: readonly string[]) => ({
    exitCode: 0,
    stdout: args.includes("rev-parse") ? "/repo/.git/index.lock" : "",
    stderr: "",
  }));
  try {
    const port = new GitMutationPort(
      { execFile, pathExists: async () => false },
      {
        platform: "darwin",
        gitExecutable: "/usr/bin/git",
        temporaryDirectory: fake.temporaryDirectory,
        confinement: {
          ...fake.confinement,
          prepare: (input) => {
            const launch = fake.confinement.prepare(input);
            if (++preparations === 3) clock = 20_000;
            return launch;
          },
        },
      },
    );
    await port.applyHunks({
      checkoutRoot: "/repo",
      action: "stage",
      patch,
      current: () => true,
      beforeApply: async () => true,
    });
    expect(
      execFile.mock.calls.filter(
        (call) => call[1].includes("apply") && !call[1].includes("--check"),
      ),
    ).toHaveLength(0);
  } finally {
    time.mockRestore();
    rmSync(fake.root, { recursive: true, force: true });
  }
});
