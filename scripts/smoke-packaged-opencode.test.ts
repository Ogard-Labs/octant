import { describe, expect, it } from "vitest";
import {
  assertProcessGroupExited,
  combineLifecycleFailures,
  findOwnedOpenCodeProcessGroup,
  type ProcessSnapshot,
} from "./smoke-packaged-opencode";

const baseline: ReadonlyArray<ProcessSnapshot> = [
  {
    pid: 54_479,
    ppid: 54_475,
    pgid: 54_475,
    command: "/older/Octant apps/server/dist/main.mjs",
  },
  {
    pid: 60_000,
    ppid: 1,
    pgid: 60_000,
    command: "/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 0",
  },
];

describe("packaged OpenCode process-group attribution", () => {
  it("detects a renamed descendant after the owned OpenCode root exits", () => {
    const server = snapshot(50_001, 49_999, 49_999, "/package/apps/server/dist/main.mjs");
    const ownedRoot = snapshot(
      60_001,
      server.pid,
      60_001,
      "/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 0",
    );
    const ownedGroup = findOwnedOpenCodeProcessGroup(baseline, [...baseline, server, ownedRoot], {
      serverCommand: "/package/apps/server/dist/main.mjs",
    });

    expect(ownedGroup).toBe(60_001);
    expect(() =>
      assertProcessGroupExited(ownedGroup, [
        ...baseline,
        snapshot(60_002, 1, 60_001, "renamed managed descendant"),
      ]),
    ).toThrow("managed process group 60001");
  });

  it("ignores a concurrent unrelated matching OpenCode command and process group", () => {
    const server = snapshot(50_001, 49_999, 49_999, "/package/apps/server/dist/main.mjs");
    const ownedRoot = snapshot(
      60_001,
      server.pid,
      60_001,
      "/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 0",
    );
    const unrelated = snapshot(
      70_001,
      70_000,
      70_001,
      "/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 0",
    );

    expect(
      findOwnedOpenCodeProcessGroup(baseline, [...baseline, server, unrelated, ownedRoot], {
        serverCommand: "/package/apps/server/dist/main.mjs",
      }),
    ).toBe(60_001);
    expect(() => assertProcessGroupExited(60_001, [...baseline, unrelated])).not.toThrow();
  });

  it("preserves baseline unrelated processes even when their command matches", () => {
    const server = snapshot(50_001, 49_999, 49_999, "/package/apps/server/dist/main.mjs");
    const ownedRoot = snapshot(
      60_001,
      server.pid,
      60_001,
      "/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 0",
    );

    expect(
      findOwnedOpenCodeProcessGroup(baseline, [...baseline, server, ownedRoot], {
        serverCommand: "/package/apps/server/dist/main.mjs",
      }),
    ).toBe(60_001);
    expect(() => assertProcessGroupExited(60_001, baseline)).not.toThrow();
  });
});

describe("packaged OpenCode lifecycle failures", () => {
  it("preserves both probe and cleanup evidence without exposing raw details", () => {
    const failure = combineLifecycleFailures(
      new Error("password=secret raw provider response"),
      new Error("OCTANT_PRIVATE=value raw process listing"),
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(String(failure)).toContain("probe/start and cleanup");
    expect(JSON.stringify(failure, errorProperties)).not.toMatch(
      /secret|raw provider|OCTANT_PRIVATE|raw process/,
    );
  });
});

function snapshot(pid: number, ppid: number, pgid: number, command: string): ProcessSnapshot {
  return { pid, ppid, pgid, command };
}

function errorProperties(_key: string, value: unknown): unknown {
  if (value instanceof AggregateError) {
    return { message: value.message, errors: value.errors };
  }
  if (value instanceof Error) return { message: value.message };
  return value;
}
