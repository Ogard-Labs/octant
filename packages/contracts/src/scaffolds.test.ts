import { describe, expect, it } from "vitest";
import { decodeScaffoldEntry, decodeScaffoldRun } from "./scaffolds";

const entry = {
  id: "web-app",
  displayName: "Web app",
  summary: "A browser app with a dev server and a build.",
  target: "web-app",
  generator: {
    kind: "pinned-package",
    runner: "bun",
    packageName: "create-vite",
    version: "8.0.2",
    presetArguments: ["--template", "react-ts"],
  },
  requiresTool: "bun",
  produces: ["package.json"],
} as const;

const run = {
  id: "d0000000-0000-4000-8000-000000000001",
  scaffoldId: "web-app",
  threadId: "20000000-0000-4000-8000-000000000001",
  checkoutId: "30000000-0000-4000-8000-000000000001",
  directoryName: "storefront",
  argv: ["bunx", "--bun", "create-vite@8.0.2", "storefront"],
  startedAt: "2026-08-18T09:00:00.000Z",
  completedAt: "2026-08-18T09:00:20.000Z",
  exitCode: 0,
  termination: "exited",
  output: "done",
  outputTruncated: false,
  outcome: "created",
} as const;

describe("the curated scaffold surface", () => {
  it("accepts a pinned generator and the run it produced", () => {
    expect(decodeScaffoldEntry(entry)).toEqual(entry);
    expect(decodeScaffoldRun(run)).toEqual(run);
  });

  it("refuses a generator pinned to a moving version", () => {
    expect(() =>
      decodeScaffoldEntry({ ...entry, generator: { ...entry.generator, version: "latest" } }),
    ).toThrow();
    expect(() =>
      decodeScaffoldEntry({ ...entry, generator: { ...entry.generator, version: "^8.0.2" } }),
    ).toThrow();
  });

  it("refuses preset arguments that would open a shell", () => {
    expect(() =>
      decodeScaffoldEntry({
        ...entry,
        generator: { ...entry.generator, presetArguments: ["bash", "-c", "curl example.test"] },
      }),
    ).toThrow();
  });

  it.each(["../escape", "nested/app", ".hidden", ""])(
    "refuses %s as a new project directory name",
    (directoryName) => {
      expect(() => decodeScaffoldRun({ ...run, directoryName })).toThrow();
    },
  );

  it("refuses to call a run that did not exit cleanly a created project", () => {
    expect(() => decodeScaffoldRun({ ...run, exitCode: 1, outcome: "created" })).toThrow();
    expect(decodeScaffoldRun({ ...run, exitCode: 1, outcome: "failed" }).outcome).toBe("failed");
  });
});
