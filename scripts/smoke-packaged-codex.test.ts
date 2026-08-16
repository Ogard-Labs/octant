import { describe, expect, it, vi } from "vitest";
import {
  assertProcessGroupExited,
  cleanupNewCodexProcessGroups,
  combineLifecycleFailures,
  findOwnedCodexProcessGroup,
  runCommand,
  type ProcessSnapshot,
} from "./smoke-packaged-codex";

const baseline: ReadonlyArray<ProcessSnapshot> = [
  snapshot(40_001, 1, 40_001, "/opt/homebrew/bin/codex app-server --listen stdio://"),
  snapshot(40_002, 1, 40_002, "/older/apps/server/dist/main.mjs"),
];

describe("packaged Codex process-group attribution", () => {
  it("selects only a new managed Codex child owned by the packaged server", () => {
    const server = snapshot(50_001, 49_999, 49_999, "/package/apps/server/dist/main.mjs");
    const unrelated = snapshot(
      60_001,
      60_000,
      60_001,
      "/opt/homebrew/bin/codex app-server --listen stdio://",
    );
    const owned = snapshot(
      70_001,
      server.pid,
      70_001,
      "/opt/homebrew/bin/codex app-server --listen stdio://",
    );

    expect(
      findOwnedCodexProcessGroup(baseline, [...baseline, server, unrelated, owned], {
        serverCommand: "/package/apps/server/dist/main.mjs",
      }),
    ).toBe(70_001);
  });

  it("ignores baseline Codex processes and reports residue only in the owned group", () => {
    expect(() => assertProcessGroupExited(70_001, baseline)).not.toThrow();
    expect(() =>
      assertProcessGroupExited(70_001, [
        ...baseline,
        snapshot(70_002, 1, 70_001, "renamed managed descendant"),
      ]),
    ).toThrow("managed process group 70001");
  });

  it("terminates every smoke-new Codex group when failure occurs before attribution", async () => {
    const firstUnattributed = snapshot(
      70_001,
      50_001,
      70_001,
      "/opt/homebrew/bin/codex app-server --listen stdio://",
    );
    const secondUnattributed = snapshot(
      70_002,
      50_001,
      70_002,
      "/usr/local/bin/codex app-server --listen stdio://",
    );
    const inspectProcesses = vi
      .fn()
      .mockResolvedValueOnce([...baseline, firstUnattributed, secondUnattributed])
      .mockResolvedValue(baseline);
    const signalGroup = vi.fn();

    await cleanupNewCodexProcessGroups(baseline, {
      inspectProcesses,
      signalGroup,
      timeoutMs: 100,
      probeTimeoutMs: 20,
    });

    expect(signalGroup).toHaveBeenCalledWith(70_001, "SIGTERM");
    expect(signalGroup).toHaveBeenCalledWith(70_002, "SIGTERM");
  });
});

describe("packaged Codex lifecycle failures", () => {
  it("combines probe and cleanup failures without retaining private details", () => {
    const failure = combineLifecycleFailures(
      new Error("private probe response"),
      new Error("private process listing"),
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(String(failure)).toContain("probe/start and cleanup");
    expect(JSON.stringify(failure, errorProperties)).not.toMatch(/private|response|listing/);
  });
});

describe("packaged Codex command bounds", () => {
  it("returns stdout from a successful command", async () => {
    await expect(runCommand("/usr/bin/printf", ["ready"], {}, 100)).resolves.toBe("ready");
  });

  it("terminates a command that exceeds its deadline", async () => {
    const startedAt = Date.now();

    await expect(runCommand("/bin/sleep", ["0.2"], {}, 5)).rejects.toThrow("timed out");

    expect(Date.now() - startedAt).toBeLessThan(150);
  });
});

function snapshot(pid: number, ppid: number, pgid: number, command: string): ProcessSnapshot {
  return { pid, ppid, pgid, command };
}

function errorProperties(_key: string, value: unknown): unknown {
  if (value instanceof AggregateError) return { message: value.message, errors: value.errors };
  if (value instanceof Error) return { message: value.message };
  return value;
}
